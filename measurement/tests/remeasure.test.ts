import { describe, it, expect } from "vitest";
import { remeasureExperiment, type Experiment } from "../src/remeasure";
import type { EngineAdapter, EngineResult } from "../src/engine";

const makeAdapter = (
  cited: boolean,
  modelVersion: string = "gpt-4o-2024-08-06",
): EngineAdapter => ({
  async measure(
    _queryText: string,
    options: { targetDomain: string },
  ): Promise<EngineResult> {
    const source_urls = cited
      ? [`https://${options.targetDomain}/page`]
      : [];
    return {
      engine: "openai",
      appeared: cited,
      cited,
      position: cited ? 0 : null,
      source_urls,
      model_version: modelVersion,
    };
  },
});

const makeExperiment = (overrides: Partial<Experiment> = {}): Experiment => ({
  id: "exp_test_001",
  customer_id: "cust_test_001",
  pairs: [
    {
      treatment_page: { page_url: "https://acme.com/pricing", company_domain: "acme.com" },
      control_page: { page_url: "https://rival.io/pricing", company_domain: "rival.io" },
    },
  ],
  ...overrides,
});

describe("remeasureExperiment", () => {
  it("stamps every run with window_tag", async () => {
    const result = await remeasureExperiment({
      experiment: makeExperiment(),
      windowTag: "baseline",
      queryId: "qry_test",
      queryText: "best CRM",
      engine: "openai",
      adapter: makeAdapter(true),
    });

    for (const run of result.runs) {
      expect(run.window_tag).toBe("baseline");
    }
  });

  it("stamps every run with experiment_id", async () => {
    const result = await remeasureExperiment({
      experiment: makeExperiment({ id: "exp_abc_123" }),
      windowTag: "post",
      queryId: "qry_test",
      queryText: "best CRM",
      engine: "openai",
      adapter: makeAdapter(true),
    });

    for (const run of result.runs) {
      expect(run.experiment_id).toBe("exp_abc_123");
    }
  });

  it("produces baseline and post rows separately", async () => {
    const baseline = await remeasureExperiment({
      experiment: makeExperiment(),
      windowTag: "baseline",
      queryId: "qry_test",
      queryText: "best CRM",
      engine: "openai",
      adapter: makeAdapter(true),
    });

    const post = await remeasureExperiment({
      experiment: makeExperiment(),
      windowTag: "post",
      queryId: "qry_test",
      queryText: "best CRM",
      engine: "openai",
      adapter: makeAdapter(true),
    });

    expect(baseline.runs.every((r) => r.window_tag === "baseline")).toBe(true);
    expect(post.runs.every((r) => r.window_tag === "post")).toBe(true);
  });

  it("measures both treatment AND control pages (identical-arm protocol)", async () => {
    let callCount = 0;
    const trackingAdapter: EngineAdapter = {
      async measure(): Promise<EngineResult> {
        callCount++;
        return {
          engine: "openai",
          appeared: true,
          cited: true,
          position: 0,
          source_urls: ["https://acme.com/pricing"],
          model_version: "gpt-4o",
        };
      },
    };

    const result = await remeasureExperiment({
      experiment: makeExperiment({
        pairs: [
          {
            treatment_page: { page_url: "https://acme.com/a", company_domain: "acme.com" },
            control_page: { page_url: "https://rival.io/b", company_domain: "rival.io" },
          },
        ],
      }),
      windowTag: "baseline",
      queryId: "qry_test",
      queryText: "best CRM",
      engine: "openai",
      adapter: trackingAdapter,
    });

    // 2 pages × 3 baseK runs each = 6 total runs
    expect(result.runs).toHaveLength(6);
    expect(result.arms.treatment.runCount).toBe(3);
    expect(result.arms.control.runCount).toBe(3);
    expect(result.arms.treatment.pageCount).toBe(1);
    expect(result.arms.control.pageCount).toBe(1);
  });

  it("reports aggregates per page", async () => {
    const result = await remeasureExperiment({
      experiment: makeExperiment(),
      windowTag: "baseline",
      queryId: "qry_test",
      queryText: "best CRM",
      engine: "openai",
      adapter: makeAdapter(true),
    });

    expect(result.aggregates).toHaveLength(2); // 1 treatment + 1 control
    for (const agg of result.aggregates) {
      expect(agg.P_cited).toBe(1.0);
      expect(agg.K).toBe(3);
      expect(agg.ci_low).toBeDefined();
      expect(agg.ci_high).toBeDefined();
    }
  });

  it("version-stamps every row with model_version", async () => {
    const result = await remeasureExperiment({
      experiment: makeExperiment(),
      windowTag: "baseline",
      queryId: "qry_test",
      queryText: "best CRM",
      engine: "openai",
      adapter: makeAdapter(true, "gpt-4o-2024-08-06"),
    });

    expect(result.model_version).toBe("gpt-4o-2024-08-06");
    for (const run of result.runs) {
      expect(run.model_version).toBe("gpt-4o-2024-08-06");
    }
  });

  it("handles multi-pair experiments", async () => {
    const exp = makeExperiment({
      pairs: [
        {
          treatment_page: { page_url: "https://acme.com/p1", company_domain: "acme.com" },
          control_page: { page_url: "https://rival.io/p1", company_domain: "rival.io" },
        },
        {
          treatment_page: { page_url: "https://acme.com/p2", company_domain: "acme.com" },
          control_page: { page_url: "https://other.com/p2", company_domain: "other.com" },
        },
      ],
    });

    const result = await remeasureExperiment({
      experiment: exp,
      windowTag: "post",
      queryId: "qry_test",
      queryText: "best CRM",
      engine: "openai",
      adapter: makeAdapter(true),
    });

    // 4 pages × 3 baseK runs each = 12 runs, 4 aggregates
    expect(result.runs).toHaveLength(12);
    expect(result.aggregates).toHaveLength(4);
    expect(result.arms.treatment.pageCount).toBe(2);
    expect(result.arms.control.pageCount).toBe(2);
  });

  it("identical-arm protocol: treatment and control use same engine/config", async () => {
    const result = await remeasureExperiment({
      experiment: makeExperiment(),
      windowTag: "baseline",
      queryId: "qry_test",
      queryText: "best CRM",
      engine: "openai",
      adapter: makeAdapter(true),
    });

    // All runs must have the same engine
    const engines = new Set(result.runs.map((r) => r.engine));
    expect(engines.size).toBe(1);
    expect(engines.has("openai")).toBe(true);
  });

  it("produces reproducible run count (3 baseK per page)", async () => {
    const result = await remeasureExperiment({
      experiment: makeExperiment(),
      windowTag: "baseline",
      queryId: "qry_test",
      queryText: "best CRM",
      engine: "openai",
      adapter: makeAdapter(true),
    });

    // 2 pages × 3 runs = 6 total runs
    expect(result.runs).toHaveLength(6);
  });
});
