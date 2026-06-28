// P2·5 Module 2 — tests for the experiment re-measurement orchestration (src/experiment.ts).
//
// Fully OFFLINE: a FAKE EngineRegistry whose adapters return scripted EngineQueryResults; never a
// real clock or network. Two units under test:
//   1. tagExperimentRows — the PURE post-pass that rewrites window_tag + experiment_id. We assert it
//      sets both fields on every row, leaves the rest intact, and does NOT mutate its input (the
//      whole point of re-tagging AFTER measurement is that the core stays untouched and tagging is
//      trivially testable).
//   2. reMeasureExperimentWindow — the identical-arm orchestration: one measureAdaptive pass per
//      query over a pool that holds BOTH arms' pages, then tag + partition by classifyArm.
//
// The identical-arm protocol is the #1 DiD non-negotiable, so its test is STRUCTURAL: treatment and
// control share one pool/pass, and we COMPARE the two arms (same engines, same run_idx range) rather
// than checking each in isolation. All-never-cited adapters resolve at K=4 (0/4 → ci_high 0.490 <
// 0.5, the same calibration sweep.test relies on), so row counts are deterministic.

import { describe, expect, it } from "vitest";
import {
  tagExperimentRows,
  reMeasureExperimentWindow,
} from "../src/experiment";
import type { ExperimentRecord } from "../src/experiment-records";
import type { EngineAdapter, EngineRegistry } from "../src/dispatch";
import type { QueryRecord, CandidatePage } from "../src/contract-records";
import type { Citation, Engine, EngineQueryResult, MeasurementRow } from "../src/types";

// --- fixtures ----------------------------------------------------------------------------------

// Arm + pool urls. CRITICAL: a pool page's `.url` becomes the row's `page_url`, and classifyArm
// exact-matches `page_url` against treatment_page / control_page — so these must be byte-identical.
const TREATMENT_URL = "https://acme.com/pricing-v2";
const CONTROL_URL = "https://acme.com/pricing";
const COMPETITOR_URL = "https://rival.com/pricing";

/** A minimal well-formed experiment with one treatment/control pair. */
function makeExperiment(): ExperimentRecord {
  return {
    id: "exp_42",
    customer_id: "cust_1",
    pairs: [{ treatment_page: TREATMENT_URL, control_page: CONTROL_URL }],
    baseline_window: "w_base",
    post_window: "w_post",
    status: "running",
  };
}

/**
 * The shared candidate pool holding BOTH arms plus a competitor page. Every page has a non-empty
 * `company_domain` so buildLabeledRows never drops it. The pool urls match the arm urls exactly so
 * classifyArm partitions them correctly. One pool, one pass = the structural identical-arm guarantee.
 */
const POOL: CandidatePage[] = [
  { company_domain: "acme.com", url: TREATMENT_URL, role: "candidate" },
  { company_domain: "acme.com", url: CONTROL_URL, role: "candidate" },
  { company_domain: "rival.com", url: COMPETITOR_URL, role: "competitor" },
];
const poolFor = (_q: QueryRecord) => POOL;

function query(id: string, engines: Engine[] = ["openai"]): QueryRecord {
  return {
    id,
    customer_id: "cust_1",
    vertical: "v",
    text: `q ${id}`,
    seed_source: "keyword",
    target_engines: engines,
  };
}

const KEYS: Partial<Record<Engine, string>> = { openai: "k" };

function citation(domain: string, rank: number): Citation {
  return { url: `https://${domain}/p`, domain, rank };
}

/** A never-citing EngineQueryResult (resolves at K=4), stamped with a model_version. */
function result(engine: Engine, modelVersion = "gpt-5"): EngineQueryResult {
  return {
    engine,
    model_version: modelVersion,
    answer_text: "nothing relevant",
    citations: [] as Citation[],
  };
}

/** A never-citing adapter (resolves at K=4) that counts its invocations. */
function neverCitedAdapter(engine: Engine): EngineAdapter & { calls: number } {
  const fn = (async (_p: Parameters<EngineAdapter>[0]) => {
    fn.calls += 1;
    return result(engine);
  }) as EngineAdapter & { calls: number };
  fn.calls = 0;
  return fn;
}

/** A bare MeasurementRow for the pure-function tests; defaults to the "adhoc"/untagged shape. */
function row(over: Partial<MeasurementRow> = {}): MeasurementRow {
  return {
    query_id: "q1",
    page_url: TREATMENT_URL,
    engine: "openai",
    model_version: "gpt-5",
    run_idx: 0,
    appeared: false,
    cited: false,
    position: null,
    source_urls: [],
    ts: 0,
    window_tag: "adhoc",
    ...over,
  };
}

// --- tagExperimentRows (pure) ------------------------------------------------------------------

describe("tagExperimentRows", () => {
  it("sets window_tag + experiment_id on every row, leaving all other fields intact", () => {
    const rows = [
      row({ query_id: "qa", page_url: TREATMENT_URL, run_idx: 1, cited: true, position: 2 }),
      row({ query_id: "qb", page_url: CONTROL_URL, engine: "openai", source_urls: ["https://x/y"] }),
    ];

    const tagged = tagExperimentRows(rows, "post", "exp_42");

    for (const r of tagged) {
      expect(r.window_tag).toBe("post");
      expect(r.experiment_id).toBe("exp_42");
    }
    // Every OTHER field is preserved verbatim — re-tagging touches exactly two fields.
    expect(tagged[0]).toEqual({ ...rows[0], window_tag: "post", experiment_id: "exp_42" });
    expect(tagged[1]).toEqual({ ...rows[1], window_tag: "post", experiment_id: "exp_42" });
  });

  it("does NOT mutate the input array or its row objects (pure)", () => {
    const rows = [row({ query_id: "qa" }), row({ query_id: "qb" })];
    const snapshot = structuredClone(rows);

    const tagged = tagExperimentRows(rows, "baseline", "exp_99");

    // Inputs untouched: deep-equal to the pre-call snapshot (still "adhoc", no experiment_id).
    expect(rows).toEqual(snapshot);
    // Returned objects are FRESH references — never the same objects as the inputs.
    expect(tagged[0]).not.toBe(rows[0]);
    expect(tagged[1]).not.toBe(rows[1]);
  });

  it("works for the baseline window too", () => {
    const tagged = tagExperimentRows([row()], "baseline", "exp_7");
    expect(tagged[0]!.window_tag).toBe("baseline");
    expect(tagged[0]!.experiment_id).toBe("exp_7");
  });

  it("returns an empty array for empty input", () => {
    expect(tagExperimentRows([], "post", "exp_1")).toEqual([]);
  });
});

// --- reMeasureExperimentWindow: tagging + arm partition ----------------------------------------

describe("reMeasureExperimentWindow — tagging + arm partition", () => {
  it("tags every row with the window + experiment_id and partitions arms by classifyArm", async () => {
    const openai = neverCitedAdapter("openai");
    const registry: EngineRegistry = { openai };
    const experiment = makeExperiment();

    const res = await reMeasureExperimentWindow({
      experiment,
      window: "post",
      queries: [query("q1")],
      poolFor,
      registry,
      apiKeys: KEYS,
      ts: 0,
    });

    expect(res.experiment_id).toBe("exp_42");
    expect(res.window).toBe("post");

    // EVERY returned row carries this window + experiment_id (the DoD: windowed + experiment-tagged).
    expect(res.rows.length).toBeGreaterThan(0);
    for (const r of res.rows) {
      expect(r.window_tag).toBe("post");
      expect(r.experiment_id).toBe("exp_42");
    }

    // treatment_page rows → byArm.treatment, control_page rows → byArm.control.
    expect(res.byArm.treatment.length).toBeGreaterThan(0);
    expect(res.byArm.control.length).toBeGreaterThan(0);
    expect(res.byArm.treatment.every((r) => r.page_url === TREATMENT_URL)).toBe(true);
    expect(res.byArm.control.every((r) => r.page_url === CONTROL_URL)).toBe(true);

    // The competitor pool page is MEASURED + tagged (present in rows) but in NEITHER arm bucket.
    const competitorRows = res.rows.filter((r) => r.page_url === COMPETITOR_URL);
    expect(competitorRows.length).toBeGreaterThan(0);
    expect(competitorRows.every((r) => r.window_tag === "post")).toBe(true);
    expect(res.byArm.treatment.some((r) => r.page_url === COMPETITOR_URL)).toBe(false);
    expect(res.byArm.control.some((r) => r.page_url === COMPETITOR_URL)).toBe(false);

    // byArm rows carry the tags too (partition runs over the TAGGED array).
    for (const r of [...res.byArm.treatment, ...res.byArm.control]) {
      expect(r.experiment_id).toBe("exp_42");
      expect(r.window_tag).toBe("post");
    }
  });
});

// --- identical-arm protocol (the #1 DiD non-negotiable) ----------------------------------------

describe("reMeasureExperimentWindow — identical-arm protocol", () => {
  it("measures both arms in ONE shared pass: same engines + matching run_idx ranges", async () => {
    const openai = neverCitedAdapter("openai");
    const perplexity = neverCitedAdapter("perplexity");
    const registry: EngineRegistry = { openai, perplexity };

    const res = await reMeasureExperimentWindow({
      experiment: makeExperiment(),
      window: "baseline",
      queries: [query("q1", ["openai", "perplexity"])],
      poolFor,
      registry,
      apiKeys: { openai: "k", perplexity: "k" },
      ts: 0,
    });

    const treatment = res.byArm.treatment;
    const control = res.byArm.control;

    // Both arms were measured by the SAME set of engines (one shared pass, not two asymmetric ones).
    const treatmentEngines = new Set(treatment.map((r) => r.engine));
    const controlEngines = new Set(control.map((r) => r.engine));
    expect([...treatmentEngines].sort()).toEqual(["openai", "perplexity"]);
    expect([...controlEngines].sort()).toEqual([...treatmentEngines].sort());

    // ...and over the SAME run_idx range per engine (same K) — the structural symmetry guarantee.
    for (const engine of ["openai", "perplexity"] as Engine[]) {
      const tRuns = new Set(treatment.filter((r) => r.engine === engine).map((r) => r.run_idx));
      const cRuns = new Set(control.filter((r) => r.engine === engine).map((r) => r.run_idx));
      expect([...tRuns].sort()).toEqual([...cRuns].sort());
      // Never-cited → resolves at K=4: run indices 0..3.
      expect([...tRuns].sort()).toEqual([0, 1, 2, 3]);
    }
  });
});

// --- per-engine separation ---------------------------------------------------------------------

describe("reMeasureExperimentWindow — per-engine separation preserved", () => {
  it("keeps each engine's rows separate; both engines resolve independently at K=4", async () => {
    const openai = neverCitedAdapter("openai");
    const perplexity = neverCitedAdapter("perplexity");
    const registry: EngineRegistry = { openai, perplexity };

    const res = await reMeasureExperimentWindow({
      experiment: makeExperiment(),
      window: "post",
      queries: [query("q1", ["openai", "perplexity"])],
      poolFor,
      registry,
      apiKeys: { openai: "k", perplexity: "k" },
      ts: 0,
    });

    expect(openai.calls).toBe(4);
    expect(perplexity.calls).toBe(4);
    // 3 pages × 4 runs × 2 engines = 24 rows; 12 per engine.
    expect(res.rows.filter((r) => r.engine === "openai")).toHaveLength(12);
    expect(res.rows.filter((r) => r.engine === "perplexity")).toHaveLength(12);
    expect(res.rows).toHaveLength(24);
    expect(res.failures).toEqual([]);
  });
});

// --- per-engine isolation: a throwing engine --------------------------------------------------

describe("reMeasureExperimentWindow — a throwing engine is isolated", () => {
  it("tags the failure with query_id while other engines AND both arms still get measured", async () => {
    const openai = neverCitedAdapter("openai");
    const bad: EngineAdapter = async () => {
      throw new Error("perplexity boom");
    };
    const registry: EngineRegistry = { openai, perplexity: bad };

    const res = await reMeasureExperimentWindow({
      experiment: makeExperiment(),
      window: "post",
      queries: [query("q1", ["openai", "perplexity"])],
      poolFor,
      registry,
      apiKeys: { openai: "k", perplexity: "k" },
      ts: 0,
    });

    // The failure is surfaced, tagged with q1's query_id (mirrors sweep.ts).
    expect(res.failures).toEqual([
      { engine: "perplexity", error: "perplexity boom", query_id: "q1" },
    ]);
    // perplexity contributed no rows; openai's survive — and STILL cover both arms.
    expect(res.rows.every((r) => r.engine === "openai")).toBe(true);
    expect(res.byArm.treatment.length).toBeGreaterThan(0);
    expect(res.byArm.control.length).toBeGreaterThan(0);
    expect(res.byArm.treatment.every((r) => r.engine === "openai")).toBe(true);
    expect(res.byArm.control.every((r) => r.engine === "openai")).toBe(true);
  });
});

// --- baseline vs post produce disjoint window_tag sets -----------------------------------------

describe("reMeasureExperimentWindow — baseline vs post", () => {
  it("a baseline call then a post call yield correctly-tagged, disjoint window_tag sets", async () => {
    const experiment = makeExperiment();
    const common = {
      experiment,
      queries: [query("q1")],
      poolFor,
      registry: { openai: neverCitedAdapter("openai") } as EngineRegistry,
      apiKeys: KEYS,
      ts: 0,
    };

    const baseline = await reMeasureExperimentWindow({ ...common, window: "baseline" });
    const post = await reMeasureExperimentWindow({
      ...common,
      window: "post",
      registry: { openai: neverCitedAdapter("openai") },
    });

    const baselineTags = new Set(baseline.rows.map((r) => r.window_tag));
    const postTags = new Set(post.rows.map((r) => r.window_tag));
    expect([...baselineTags]).toEqual(["baseline"]);
    expect([...postTags]).toEqual(["post"]);
    // Disjoint: no window_tag appears in both windows' row sets.
    for (const tag of baselineTags) expect(postTags.has(tag)).toBe(false);
  });
});

// --- multiple queries: rows concatenated, all tagged ------------------------------------------

describe("reMeasureExperimentWindow — multiple queries", () => {
  it("concatenates rows across queries, all carrying the window + experiment_id", async () => {
    const openai = neverCitedAdapter("openai");
    const res = await reMeasureExperimentWindow({
      experiment: makeExperiment(),
      window: "baseline",
      queries: [query("q1"), query("q2")],
      poolFor,
      registry: { openai },
      apiKeys: KEYS,
      ts: 0,
    });

    // 2 queries × 3 pages × 4 runs (single engine) = 24 rows.
    expect(res.rows).toHaveLength(24);
    expect(res.rows.every((r) => r.window_tag === "baseline" && r.experiment_id === "exp_42")).toBe(true);
    // Both queries contributed rows.
    expect(new Set(res.rows.map((r) => r.query_id))).toEqual(new Set(["q1", "q2"]));
  });
});
