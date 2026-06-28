import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeDomain, normalizeUrl } from "../../convex/lib/domain";

// The Phase-0 thin slice, validated deterministically: every key is already
// normalized (so re-normalizing is a no-op) and every cross-lane join resolves.
// This is the "thin slice runs E2E on seed data" milestone, checkable offline —
// it catches the #1 silent-failure mode (a key that doesn't join) at CI time.
const FX = join(__dirname, "../../tests/integration/fixtures");
const load = (f: string) => JSON.parse(readFileSync(join(FX, f), "utf8"));

const workspace = load("workspace.json");
const companies = load("companies.json");
const pages = load("pages.json");
const measurements = load("measurements.json");
const experiments = load("experiments.json");
const liftResults = load("lift_results.json");
const interventions = load("interventions.json");

describe("fixtures: keys are normalized (idempotent under the helper)", () => {
  it("workspace domains", () => {
    expect(workspace.own_domain).toBe(normalizeDomain(workspace.own_domain));
    for (const c of workspace.competitor_domains) {
      expect(c).toBe(normalizeDomain(c));
    }
    expect(workspace.competitor_domains).not.toContain(workspace.own_domain);
  });

  it("company.domain", () => {
    for (const c of companies) {
      expect(c.domain).toBe(normalizeDomain(c.domain));
    }
  });

  it("page.url and page.company_domain", () => {
    for (const p of pages) {
      expect(p.url).toBe(normalizeUrl(p.url));
      expect(p.company_domain).toBe(normalizeDomain(p.company_domain));
    }
  });

  it("measurement.page_url and source_urls", () => {
    for (const m of measurements) {
      expect(m.page_url).toBe(normalizeUrl(m.page_url));
      for (const s of m.source_urls) expect(s).toBe(normalizeDomain(s));
    }
  });
});

describe("fixtures: cross-lane joins resolve", () => {
  const companyDomains = new Set(companies.map((c: any) => c.domain));
  const pageUrls = new Set(pages.map((p: any) => p.url));
  const experimentIds = new Set(experiments.map((e: any) => e._id));

  it("every page joins to a company", () => {
    for (const p of pages) expect(companyDomains.has(p.company_domain)).toBe(true);
  });

  it("every measurement joins to a page", () => {
    for (const m of measurements) expect(pageUrls.has(m.page_url)).toBe(true);
  });

  it("every lift_result / intervention joins to an experiment", () => {
    for (const lr of liftResults) expect(experimentIds.has(lr.experiment_id)).toBe(true);
    for (const iv of interventions) expect(experimentIds.has(iv.experiment_id)).toBe(true);
  });
});

describe("fixtures: the gut-punch story is intact (descriptive layer only)", () => {
  it("Acme is cited 0/1 and Competitor 1/1 by OpenAI", () => {
    const byUrl = (u: string) =>
      measurements.find((m: any) => m.page_url === u && m.engine === "openai");
    expect(byUrl("https://acme.com/pricing").cited).toBe(false);
    expect(byUrl("https://competitor.com/pricing").cited).toBe(true);
  });
});
