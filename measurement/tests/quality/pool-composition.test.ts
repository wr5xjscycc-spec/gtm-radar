import { describe, it, expect } from "vitest";
import {
  assessPoolComposition,
  type DomainShare,
  type CompositionReport,
} from "../../src/quality/pool-composition";
import type { CandidatePage } from "../../src/contract-records";

// P2·4 Module 3 — pool-composition sanity (case-control gotcha).
// A loser pool dominated by one company biases the model: this report quantifies that.
// Operates on ONE category's pool (caller groups by vertical). Grouping is on the
// NORMALIZED company_domain (normalizeDomain — the contract's join key). Pure function,
// defensive on garbage domains (same posture as labeling.ts). No network; literal pools.

// Helper: build a candidate page. role is irrelevant to composition but required by the shape.
const page = (company_domain: string, url = `https://${company_domain}/x`): CandidatePage => ({
  company_domain,
  url,
  role: "candidate",
});

describe("assessPoolComposition", () => {
  it("a balanced 2-domain pool (2/2) is NOT dominated", () => {
    const pool: CandidatePage[] = [
      page("alpha.com", "https://alpha.com/a"),
      page("alpha.com", "https://alpha.com/b"),
      page("beta.com", "https://beta.com/a"),
      page("beta.com", "https://beta.com/b"),
    ];

    const report = assessPoolComposition(pool);

    expect(report.n_pages).toBe(4);
    expect(report.n_companies).toBe(2);
    expect(report.dominated).toBe(false);
    expect(report.offenders).toEqual([]);
    // shares desc by n_pages then domain asc — equal counts → domain asc (alpha before beta).
    expect(report.shares).toEqual<DomainShare[]>([
      { company_domain: "alpha.com", n_pages: 2, share: 0.5 },
      { company_domain: "beta.com", n_pages: 2, share: 0.5 },
    ]);
  });

  it("one domain holding 3/4 is dominated, and that domain is the offender", () => {
    const pool: CandidatePage[] = [
      page("alpha.com", "https://alpha.com/a"),
      page("alpha.com", "https://alpha.com/b"),
      page("alpha.com", "https://alpha.com/c"),
      page("beta.com", "https://beta.com/a"),
    ];

    const report = assessPoolComposition(pool);

    expect(report.n_pages).toBe(4);
    expect(report.n_companies).toBe(2);
    expect(report.dominated).toBe(true);
    // 3/4 = 0.75 > 0.5 default → offender. 1/4 = 0.25 is not.
    expect(report.offenders).toEqual<DomainShare[]>([
      { company_domain: "alpha.com", n_pages: 3, share: 0.75 },
    ]);
    // shares sorted desc by n_pages.
    expect(report.shares).toEqual<DomainShare[]>([
      { company_domain: "alpha.com", n_pages: 3, share: 0.75 },
      { company_domain: "beta.com", n_pages: 1, share: 0.25 },
    ]);
  });

  it("a share of EXACTLY 0.5 with the default threshold is NOT dominated (strict >)", () => {
    // 1 of 2 = 0.5 each — boundary case. Strict `>` means neither crosses.
    const pool: CandidatePage[] = [page("alpha.com"), page("beta.com")];

    const report = assessPoolComposition(pool);

    expect(report.shares.map((s) => s.share)).toEqual([0.5, 0.5]);
    expect(report.dominated).toBe(false);
    expect(report.offenders).toEqual([]);
  });

  it("honors a custom dominanceThreshold", () => {
    // 3/4 = 0.75. With threshold 0.8 → not dominated; with 0.7 → dominated.
    const pool: CandidatePage[] = [
      page("alpha.com", "https://alpha.com/a"),
      page("alpha.com", "https://alpha.com/b"),
      page("alpha.com", "https://alpha.com/c"),
      page("beta.com", "https://beta.com/a"),
    ];

    const lenient = assessPoolComposition(pool, { dominanceThreshold: 0.8 });
    expect(lenient.dominated).toBe(false);
    expect(lenient.offenders).toEqual([]);

    const strict = assessPoolComposition(pool, { dominanceThreshold: 0.7 });
    expect(strict.dominated).toBe(true);
    expect(strict.offenders).toEqual<DomainShare[]>([
      { company_domain: "alpha.com", n_pages: 3, share: 0.75 },
    ]);

    // The threshold is strict: exactly 0.75 with threshold 0.75 is NOT dominated.
    const exact = assessPoolComposition(pool, { dominanceThreshold: 0.75 });
    expect(exact.dominated).toBe(false);
    expect(exact.offenders).toEqual([]);
  });

  it("groups on the NORMALIZED domain (so www / scheme / case collapse together)", () => {
    // alpha.com, www.alpha.com, HTTPS://ALPHA.COM all normalize to alpha.com → one company.
    const pool: CandidatePage[] = [
      page("alpha.com", "https://alpha.com/a"),
      page("www.alpha.com", "https://www.alpha.com/b"),
      page("HTTPS://ALPHA.COM/path", "https://alpha.com/c"),
      page("beta.com", "https://beta.com/a"),
    ];

    const report = assessPoolComposition(pool);

    expect(report.n_companies).toBe(2);
    expect(report.shares).toEqual<DomainShare[]>([
      { company_domain: "alpha.com", n_pages: 3, share: 0.75 },
      { company_domain: "beta.com", n_pages: 1, share: 0.25 },
    ]);
    expect(report.dominated).toBe(true);
    expect(report.offenders).toEqual<DomainShare[]>([
      { company_domain: "alpha.com", n_pages: 3, share: 0.75 },
    ]);
  });

  it("excludes pages whose company_domain normalizes to '' (garbage) without crashing", () => {
    // "" and "   " normalize to "" → dropped from counts entirely (defensive, like labeling.ts).
    // n_pages_total is the count of KEPT pages, so shares are computed on real pages only.
    const pool: CandidatePage[] = [
      page("alpha.com", "https://alpha.com/a"),
      page("alpha.com", "https://alpha.com/b"),
      { company_domain: "", url: "https://garbage/x", role: "candidate" },
      { company_domain: "   ", url: "https://garbage/y", role: "candidate" },
      page("beta.com", "https://beta.com/a"),
    ];

    const report = assessPoolComposition(pool);

    // Only the 3 real pages counted; the 2 garbage pages excluded.
    expect(report.n_pages).toBe(3);
    expect(report.n_companies).toBe(2);
    expect(report.shares).toEqual<DomainShare[]>([
      { company_domain: "alpha.com", n_pages: 2, share: 2 / 3 },
      { company_domain: "beta.com", n_pages: 1, share: 1 / 3 },
    ]);
    // 2/3 ≈ 0.667 > 0.5 → dominated.
    expect(report.dominated).toBe(true);
    expect(report.offenders).toEqual<DomainShare[]>([
      { company_domain: "alpha.com", n_pages: 2, share: 2 / 3 },
    ]);
  });

  it("an empty pool yields zeros / empties / false — never NaN", () => {
    const report: CompositionReport = assessPoolComposition([]);

    expect(report.n_pages).toBe(0);
    expect(report.n_companies).toBe(0);
    expect(report.shares).toEqual([]);
    expect(report.dominated).toBe(false);
    expect(report.offenders).toEqual([]);
    // No NaN anywhere (would arise from a 0/0 share).
    expect(Number.isNaN(report.n_pages)).toBe(false);
  });

  it("a pool of only garbage domains behaves like an empty pool (no NaN, no crash)", () => {
    const pool: CandidatePage[] = [
      { company_domain: "", url: "https://garbage/x", role: "candidate" },
      { company_domain: "  ", url: "https://garbage/y", role: "candidate" },
    ];

    const report = assessPoolComposition(pool);

    expect(report.n_pages).toBe(0);
    expect(report.n_companies).toBe(0);
    expect(report.shares).toEqual([]);
    expect(report.dominated).toBe(false);
    expect(report.offenders).toEqual([]);
  });

  it("breaks share ties by domain ascending (deterministic order)", () => {
    // Three domains each with 1 page → equal shares → sorted by domain asc.
    const pool: CandidatePage[] = [
      page("gamma.com"),
      page("alpha.com"),
      page("beta.com"),
    ];

    const report = assessPoolComposition(pool);

    expect(report.shares.map((s) => s.company_domain)).toEqual([
      "alpha.com",
      "beta.com",
      "gamma.com",
    ]);
  });
});
