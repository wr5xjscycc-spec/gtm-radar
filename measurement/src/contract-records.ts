// P2 (Measurement) — minimal projections of records OWNED BY OTHER LANES that P2 reads.
//
// These mirror docs/CONTRACT.md (the `query` record §4, the `page` record §3) but include
// ONLY the fields P2's dispatch + labeling need. The authoritative typed shapes live in P1's
// Convex schema; until P1·0 / P3 land, we consume these against lane-local fixtures and key
// everything on the normalized domain (never invent a key format). Do NOT add fields here to
// "extend" the contract — that requires the ORCHESTRATION.md §4 sign-off.

import type { Engine } from "./types";

export type SeedSource = "paa" | "keyword" | "reddit" | "analytics" | "llm_expand";

/** Projection of the `query` record (docs/CONTRACT.md §4) — what the dispatch harness consumes. */
export interface QueryRecord {
  id: string;
  customer_id: string;
  vertical: string;
  text: string;
  seed_source: SeedSource;
  /** Which engines to measure this query on. OpenAI-only ⇒ ["openai"]. */
  target_engines: Engine[];
}

export type PageRole = "candidate" | "customer" | "competitor";

/**
 * Projection of the `page` record (docs/CONTRACT.md §3) — the fields labeling needs.
 * The case-control candidate pool is the set of pages with `role: "candidate"` (retrieved /
 * considered for a query, or classic-search-ranked), produced by P3·3. A "loser" may come ONLY
 * from this pool — never an arbitrary uncited page.
 */
export interface CandidatePage {
  company_domain: string;
  url: string;
  role: PageRole;
}
