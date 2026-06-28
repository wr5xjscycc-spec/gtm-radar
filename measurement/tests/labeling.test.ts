import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { labelCaseControl, mapCitationsToPages } from "../src/labeling";
import type { Citation } from "../src/types";
import type { CandidatePage } from "../src/contract-records";

// P2 case-control labeling (ORCHESTRATION.md §6, P2 brief Phase 2).
// A "loser" is a page that was IN the candidate pool but was NOT cited — never an
// arbitrary uncited page from outside the pool (that reintroduces selection bias).
// Pure functions only — no network/engine calls; pools/citations are constructed literals.

// The real fixture: candidates for syncgtm.com, seraleads.com, salesmotion.io (cited) plus
// apollo.io, outreach.io (in pool, NOT cited).
const fixturePool: CandidatePage[] = JSON.parse(
  readFileSync(new URL("./fixtures/candidate-pool.json", import.meta.url), "utf8"),
);

const domains = (pages: CandidatePage[]): string[] =>
  pages.map((p) => p.company_domain).sort();

describe("labelCaseControl", () => {
  it("labels the fixture pool: the 3 cited pages win, the 2 in-pool-but-uncited pages lose", () => {
    const { winners, losers } = labelCaseControl(
      ["syncgtm.com", "seraleads.com", "salesmotion.io"],
      fixturePool,
    );

    expect(domains(winners)).toEqual([
      "salesmotion.io",
      "seraleads.com",
      "syncgtm.com",
    ]);
    expect(domains(losers)).toEqual(["apollo.io", "outreach.io"]);
    // Every pool page is classified exactly once — nothing dropped, nothing duplicated.
    expect(winners.length + losers.length).toBe(fixturePool.length);
  });

  // THE selection-bias guard: a loser may ONLY come from the candidate pool. An uncited page
  // that lives OUTSIDE the pool must never be invented as a loser.
  it("never labels an uncited, out-of-pool page as a loser (selection-bias guard)", () => {
    const pool: CandidatePage[] = [
      { company_domain: "syncgtm.com", url: "https://syncgtm.com/x", role: "candidate" },
      { company_domain: "apollo.io", url: "https://apollo.io/y", role: "candidate" },
    ];
    // Uncited AND not in the pool. It is referenced only here — it must surface nowhere.
    const outsider: CandidatePage = {
      company_domain: "random-uncited.com",
      url: "https://random-uncited.com/z",
      role: "candidate",
    };

    const result = labelCaseControl(["syncgtm.com"], pool);
    const all = [...result.winners, ...result.losers];

    // Losers (and winners) are drawn ONLY from the pool — and by reference, not clones.
    expect(result.losers.every((p) => pool.includes(p))).toBe(true);
    expect(result.winners.every((p) => pool.includes(p))).toBe(true);
    // The out-of-pool, uncited domain appears nowhere — neither the object nor its domain.
    expect(all.includes(outsider)).toBe(false);
    expect(all.some((p) => p.company_domain === "random-uncited.com")).toBe(false);
    // apollo.io is IN the pool and uncited → correctly a loser (the case-control case).
    expect(domains(result.losers)).toEqual(["apollo.io"]);
    expect(domains(result.winners)).toEqual(["syncgtm.com"]);
  });

  it("normalizes raw/mixed-case cited urls before matching pool domains", () => {
    const pool: CandidatePage[] = [
      { company_domain: "syncgtm.com", url: "https://syncgtm.com/blog", role: "candidate" },
    ];

    const { winners, losers } = labelCaseControl(
      ["https://www.SyncGTM.com/blog/x"],
      pool,
    );

    // Same object reference comes back as a winner.
    expect(winners).toEqual(pool);
    expect(winners[0]).toBe(pool[0]);
    expect(losers).toEqual([]);
  });

  it("drops cited entries that normalize to empty without inventing matches", () => {
    const pool: CandidatePage[] = [
      { company_domain: "syncgtm.com", url: "https://syncgtm.com", role: "candidate" },
    ];

    // "" and whitespace normalize to "" and must be discarded from the cited set.
    const { winners, losers } = labelCaseControl(["", "   ", "syncgtm.com"], pool);

    expect(domains(winners)).toEqual(["syncgtm.com"]);
    expect(losers).toEqual([]);
  });

  it("makes every valid pool page a loser when nothing was cited", () => {
    const { winners, losers } = labelCaseControl([], fixturePool);

    expect(winners).toEqual([]);
    expect(losers.length).toBe(fixturePool.length);
    expect(losers.every((p) => fixturePool.includes(p))).toBe(true);
  });

  it("returns empty winners and losers for an empty pool (invents no losers)", () => {
    const { winners, losers } = labelCaseControl(["syncgtm.com"], []);

    expect(winners).toEqual([]);
    expect(losers).toEqual([]);
  });

  it("skips a pool page whose domain is garbage (empty normalized) without throwing", () => {
    const pool: CandidatePage[] = [
      { company_domain: "", url: "not-a-real-url", role: "candidate" },
      { company_domain: "syncgtm.com", url: "https://syncgtm.com", role: "candidate" },
    ];

    const { winners, losers } = labelCaseControl(["syncgtm.com"], pool);

    expect(domains(winners)).toEqual(["syncgtm.com"]);
    expect(losers).toEqual([]);
    // The garbage page is in neither bucket.
    expect(winners.length + losers.length).toBe(1);
  });
});

describe("mapCitationsToPages", () => {
  it("maps each page (in order) to its first citation rank, or null when uncited", () => {
    const citations: Citation[] = [
      { url: "https://other.io/a", domain: "other.io", rank: 1 },
      { url: "https://syncgtm.com/blog", domain: "syncgtm.com", rank: 2 },
    ];
    const pages: CandidatePage[] = [
      // company_domain given as a raw url to prove it is normalized before comparing.
      { company_domain: "https://www.SyncGTM.com/blog/x", url: "https://syncgtm.com/blog", role: "candidate" },
      { company_domain: "apollo.io", url: "https://apollo.io", role: "candidate" },
      { company_domain: "", url: "garbage", role: "candidate" },
    ];

    const out = mapCitationsToPages(citations, pages);

    expect(out).toEqual([
      { page: pages[0], cited: true, position: 2 }, // c.rank, not array index (0)
      { page: pages[1], cited: false, position: null },
      { page: pages[2], cited: false, position: null }, // empty domain ⇒ never cited
    ]);
    // One entry per page, in order, carrying the original page reference.
    expect(out).toHaveLength(pages.length);
    expect(out[0]!.page).toBe(pages[0]);
  });

  it("picks the FIRST matching citation when a domain is cited more than once", () => {
    const citations: Citation[] = [
      { url: "https://syncgtm.com/a", domain: "syncgtm.com", rank: 5 },
      { url: "https://syncgtm.com/b", domain: "syncgtm.com", rank: 9 },
    ];
    const pages: CandidatePage[] = [
      { company_domain: "syncgtm.com", url: "https://syncgtm.com", role: "candidate" },
    ];

    const out = mapCitationsToPages(citations, pages);

    expect(out).toEqual([{ page: pages[0], cited: true, position: 5 }]);
  });
});
