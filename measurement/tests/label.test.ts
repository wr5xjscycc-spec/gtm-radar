import { describe, it, expect } from "vitest";
import { labelMeasurements, labelFromTargetDomain } from "../src/label";
import type { EngineResult } from "../src/engine";
import candidatePagesFixture from "./fixtures/candidate-pages.json";

const engineResultCited: EngineResult = {
  engine: "openai",
  appeared: true,
  cited: true,
  position: 0,
  source_urls: [
    "https://acme.com/pricing",
    "https://competitor.com/pricing",
    "https://g2.com/products",
  ],
  model_version: "gpt-4o-2024-08-06",
};

const engineResultNotCited: EngineResult = {
  engine: "openai",
  appeared: true,
  cited: true,
  position: 0,
  source_urls: [
    "https://hubspot.com/products",
    "https://salesforce.com/products",
  ],
  model_version: "gpt-4o-2024-08-06",
};

const engineResultEmpty: EngineResult = {
  engine: "openai",
  appeared: false,
  cited: false,
  position: null,
  source_urls: [],
  model_version: "gpt-4o-2024-08-06",
};

describe("labelMeasurements", () => {
  it("labels cited candidate pages as winners", () => {
    const result = labelMeasurements(
      "qry_test",
      engineResultCited,
      candidatePagesFixture,
    );

    const acme = result.rows.find((r) => r.company_domain === "acme.com");
    expect(acme?.label).toBe("winner");
    expect(acme?.cited).toBe(true);
  });

  it("labels uncited candidate pages as losers", () => {
    const result = labelMeasurements(
      "qry_test",
      engineResultCited,
      candidatePagesFixture,
    );

    const rival = result.rows.find((r) => r.company_domain === "rival.io");
    expect(rival?.label).toBe("loser");
    expect(rival?.cited).toBe(false);
  });

  it("labels ALL candidate pages as losers when engine cites nothing relevant", () => {
    const result = labelMeasurements(
      "qry_test",
      engineResultNotCited,
      candidatePagesFixture,
    );

    expect(result.rows).toHaveLength(3);
    for (const row of result.rows) {
      expect(row.label).toBe("loser");
    }
  });

  it("labels ALL candidate pages as losers on empty source URLs", () => {
    const result = labelMeasurements(
      "qry_test",
      engineResultEmpty,
      candidatePagesFixture,
    );

    expect(result.rows).toHaveLength(3);
    for (const row of result.rows) {
      expect(row.label).toBe("loser");
      expect(row.cited).toBe(false);
    }
  });

  it("rejects arbitrary uncited pages — only candidate-pool pages get labeled", () => {
    const result = labelMeasurements(
      "qry_test",
      engineResultCited,
      candidatePagesFixture,
    );

    const domains = result.rows.map((r) => r.company_domain);
    expect(domains).toEqual(
      expect.arrayContaining(["acme.com", "competitor.com", "rival.io"]),
    );
    // No arbitrary domain like "g2.com" or "hubspot.com" should appear
    expect(domains).not.toContain("g2.com");
    expect(domains).not.toContain("hubspot.com");
  });
});

describe("labelFromTargetDomain", () => {
  it("adds specific target page to the labeled set", () => {
    const result = labelFromTargetDomain(
      "qry_test",
      engineResultCited,
      "acme.com",
      "https://acme.com/pricing",
      candidatePagesFixture,
    );

    const acmeRows = result.rows.filter(
      (r) => r.company_domain === "acme.com",
    );
    expect(acmeRows.length).toBeGreaterThanOrEqual(1);

    const targetRow = acmeRows[acmeRows.length - 1];
    expect(targetRow.label).toBe("winner");
    expect(targetRow.page_url).toBe("https://acme.com/pricing");
  });
});
