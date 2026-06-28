import { describe, it, expect } from "vitest";
import { deriveEngineResult, buildMeasurementRow } from "../src/measurement";
import type { Citation, EngineResult } from "../src/types";

// P2 measurement-row builder: turns parsed citations + a target page into the
// engine-agnostic {appeared, cited, position, sources[]} shape (ARCHITECTURE.md §8)
// and the frozen `measurement` contract record (CONTRACT.md §5).
// Pure functions only — NO network/engine calls; citations are constructed literals.

describe("deriveEngineResult", () => {
  it("matches the target by normalized domain regardless of URL path/case", () => {
    // The matching citation is FIRST in the array but carries rank:2, so a buggy
    // findIndex()+1 implementation would wrongly report position:1.
    const citations: Citation[] = [
      { url: "https://www.example.com/pricing", domain: "example.com", rank: 2 },
      { url: "https://other.io/a", domain: "other.io", rank: 1 },
      { url: "https://third.dev/b", domain: "third.dev", rank: 3 },
    ];

    const result = deriveEngineResult(citations, "https://www.Example.com/pricing");

    expect(result.cited).toBe(true);
    expect(result.position).toBe(2); // c.rank, not array index
    expect(result.appeared).toBe(true); // cited ⇒ appeared
    expect(result.sources.length).toBe(citations.length);
  });

  it("is not cited and has no position when the target domain is absent (no answerText)", () => {
    const citations: Citation[] = [
      { url: "https://other.io/a", domain: "other.io", rank: 1 },
      { url: "https://third.dev/b", domain: "third.dev", rank: 2 },
    ];

    const result = deriveEngineResult(citations, "https://example.com/pricing");

    expect(result.cited).toBe(false);
    expect(result.position).toBe(null);
    expect(result.appeared).toBe(false); // no answerText ⇒ appeared === cited
  });

  it("appeared is true (but cited false) when the domain shows up only in answerText", () => {
    const citations: Citation[] = [
      { url: "https://other.io/a", domain: "other.io", rank: 1 },
    ];
    const answerText = "Per their docs, EXAMPLE.com offers a free tier worth a look.";

    const result = deriveEngineResult(citations, "https://example.com/pricing", answerText);

    expect(result.cited).toBe(false);
    expect(result.position).toBe(null);
    expect(result.appeared).toBe(true); // case-insensitive mention in the answer
  });

  it("preserves citation order in sources and returns the raw urls verbatim", () => {
    const citations: Citation[] = [
      { url: "https://b.com/2?utm=1", domain: "b.com", rank: 1 },
      { url: "https://a.com/1", domain: "a.com", rank: 2 },
      { url: "HTTPS://C.com/3#x", domain: "c.com", rank: 3 },
    ];

    const result = deriveEngineResult(citations, "https://nomatch.com");

    expect(result.sources).toEqual([
      "https://b.com/2?utm=1",
      "https://a.com/1",
      "HTTPS://C.com/3#x",
    ]);
  });

  it("returns all false/null for an empty targetPageUrl without throwing", () => {
    // Guard MUST short-circuit before the substring/=== checks: "".includes("") is true
    // and "" === "" is true, so a naive impl would wrongly flip appeared/cited.
    const citations: Citation[] = [
      { url: "not-a-real-url", domain: "", rank: 1 }, // garbage domain normalizes to ""
      { url: "https://other.io/a", domain: "other.io", rank: 2 },
    ];
    const answerText = "some answer text that contains everything as a superset";

    const result = deriveEngineResult(citations, "", answerText);

    expect(result.cited).toBe(false);
    expect(result.position).toBe(null);
    expect(result.appeared).toBe(false);
    // sources are still mapped through even in the empty-target branch.
    expect(result.sources).toEqual(["not-a-real-url", "https://other.io/a"]);
  });
});

describe("buildMeasurementRow", () => {
  const engineResult: EngineResult = {
    appeared: true,
    cited: false,
    position: null,
    sources: ["https://other.io/a", "https://b.com/2"],
  };

  it("produces exactly the contract keys and defaults window_tag to 'adhoc'", () => {
    const row = buildMeasurementRow({
      queryId: "q_123",
      pageUrl: "https://example.com/pricing",
      engine: "openai",
      modelVersion: "gpt-4o-2024-11-20",
      runIdx: 3,
      engineResult,
      ts: 1_700_000_000_000,
    });

    expect(row).toEqual({
      query_id: "q_123",
      page_url: "https://example.com/pricing",
      engine: "openai",
      model_version: "gpt-4o-2024-11-20",
      run_idx: 3,
      appeared: true,
      cited: false,
      position: null, // null position preserved
      source_urls: ["https://other.io/a", "https://b.com/2"],
      ts: 1_700_000_000_000,
      window_tag: "adhoc",
    });
    // id is assigned by Convex/P1 on persist — never set here.
    expect("id" in row).toBe(false);
    // experiment_id absent (not undefined) when not provided.
    expect("experiment_id" in row).toBe(false);
  });

  it("honors a provided window_tag and includes experiment_id when given", () => {
    const row = buildMeasurementRow({
      queryId: "q_456",
      pageUrl: "https://example.com/",
      engine: "perplexity",
      modelVersion: "sonar-pro",
      runIdx: 0,
      engineResult,
      ts: 1_700_000_000_001,
      windowTag: "baseline",
      experimentId: "exp_789",
    });

    expect(row.window_tag).toBe("baseline");
    expect("experiment_id" in row).toBe(true);
    expect(row.experiment_id).toBe("exp_789");
    expect(row.run_idx).toBe(0); // passed through, incl. falsy 0
    expect(row.source_urls).toBe(engineResult.sources); // passed through by reference
  });
});
