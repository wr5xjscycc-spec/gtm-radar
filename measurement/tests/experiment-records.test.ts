// Tests for the experiment-record projection (Module 1, src/experiment-records.ts).
//
// classifyArm is the load-bearing primitive P2·5 uses to partition tagged rows by arm, so every
// branch the spec enumerates is encoded here: treatment/control hits, the null cases (unrelated &
// near-miss urls), multi-pair scanning, the malformed dual-listed treatment-precedence case, and
// the empty-pairs degenerate. These run RED until experiment-records.ts exists.

import { describe, it, expect } from "vitest";
import {
  classifyArm,
  type ExperimentRecord,
  type ExperimentPair,
} from "../src/experiment-records";

/** A minimal well-formed experiment with one treatment/control pair. */
function makeExperiment(pairs: ExperimentPair[]): ExperimentRecord {
  return {
    id: "exp_1",
    customer_id: "cust_1",
    pairs,
    baseline_window: "w_base",
    post_window: "w_post",
    status: "running",
  };
}

describe("classifyArm", () => {
  it("classifies a treatment_page url as \"treatment\"", () => {
    const exp = makeExperiment([
      { treatment_page: "https://acme.com/pricing-v2", control_page: "https://acme.com/pricing" },
    ]);
    expect(classifyArm("https://acme.com/pricing-v2", exp)).toBe("treatment");
  });

  it("classifies a control_page url as \"control\"", () => {
    const exp = makeExperiment([
      { treatment_page: "https://acme.com/pricing-v2", control_page: "https://acme.com/pricing" },
    ]);
    expect(classifyArm("https://acme.com/pricing", exp)).toBe("control");
  });

  it("returns null for an unrelated url (e.g. a competitor pool page)", () => {
    const exp = makeExperiment([
      { treatment_page: "https://acme.com/pricing-v2", control_page: "https://acme.com/pricing" },
    ]);
    expect(classifyArm("https://competitor.com/pricing", exp)).toBeNull();
  });

  it("scans every pair, not just the first", () => {
    const exp = makeExperiment([
      { treatment_page: "https://acme.com/a-v2", control_page: "https://acme.com/a" },
      { treatment_page: "https://acme.com/b-v2", control_page: "https://acme.com/b" },
    ]);
    // Hit lives in the SECOND pair for both arms.
    expect(classifyArm("https://acme.com/b-v2", exp)).toBe("treatment");
    expect(classifyArm("https://acme.com/b", exp)).toBe("control");
  });

  it("matches exactly — a near-miss / trailing-slash url is null", () => {
    const exp = makeExperiment([
      { treatment_page: "https://acme.com/pricing-v2", control_page: "https://acme.com/pricing" },
    ]);
    // Trailing slash, case difference, and substring are all NON-matches.
    expect(classifyArm("https://acme.com/pricing-v2/", exp)).toBeNull();
    expect(classifyArm("https://acme.com/Pricing-v2", exp)).toBeNull();
    expect(classifyArm("https://acme.com/pricing-v", exp)).toBeNull();
  });

  it("prefers treatment when a url is (malformedly) listed in both arms", () => {
    const exp = makeExperiment([
      { treatment_page: "https://acme.com/dup", control_page: "https://acme.com/dup" },
    ]);
    expect(classifyArm("https://acme.com/dup", exp)).toBe("treatment");
  });

  it("prefers treatment even when the dual-listing spans different pairs", () => {
    const exp = makeExperiment([
      { treatment_page: "https://acme.com/x", control_page: "https://acme.com/x-control" },
      { treatment_page: "https://acme.com/y", control_page: "https://acme.com/x" },
    ]);
    // /x is a treatment in pair 0 and a control in pair 1 — treatment wins.
    expect(classifyArm("https://acme.com/x", exp)).toBe("treatment");
  });

  it("returns null when there are no pairs", () => {
    const exp = makeExperiment([]);
    expect(classifyArm("https://acme.com/pricing", exp)).toBeNull();
  });
});
