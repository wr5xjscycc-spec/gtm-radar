import { describe, it, expect } from "vitest";

// Harness smoke test — proves the P2 test runner works in CI.
// Replace/extend per the P2 Testing standard:
//  - OpenAI Responses + web_search adapter with MOCKED HTTP returning url_citation fixtures
//  - K-repeats -> P(cited)+CI math, adaptive-sampling stopping rule (Wilson CI)
//  - case-control labeling (a "loser" comes ONLY from the candidate pool)
//  NEVER call live engine APIs in CI.
describe("measurement harness", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
