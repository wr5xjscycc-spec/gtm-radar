// Battlefield builder (P3 · Phase 0).
//
// Goal of the phase: prove company sourcing through Fiber. Call
// `find-similar-companies` for one seed customer and write `company` records
// (role=battlefield) keyed on NORMALIZED domain.
//
// Lane discipline: this lane never writes Convex directly (that's P1's code).
// It depends on a `CompanyWriter` PORT; in Phase 0 tests/integration use an
// in-memory writer, and P1's Convex `company` mutation is injected at the edge.

import { normalizeDomain } from "./domain";
import {
  FIBER_BATTLEFIELD_VERSION,
  type FiberClient,
  type FiberCompany,
} from "./fiber";
import type { Company } from "./types";

/**
 * Sink for `company` records. The real implementation is P1's Convex mutation
 * (`company` upsert keyed on normalized domain); tests pass an in-memory stub.
 * Upsert semantics (keyed on `company.domain`) so re-runs don't duplicate.
 */
export interface CompanyWriter {
  upsertCompany(company: Company): Promise<void>;
}

export interface BuildBattlefieldArgs {
  /** Seed customer domain (raw OK — normalized internally). */
  customerDomain: string;
  /** Soft cap forwarded to Fiber. Phase 0 = a handful; Phase 1 expands to 20–40. */
  limit?: number;
}

/** Map one Fiber result to a contract-shaped `company` battlefield record. */
export function toBattlefieldCompany(raw: FiberCompany): Company {
  const domain = normalizeDomain(raw.domain);
  const name = (raw.name ?? "").trim() || domain;
  return {
    domain,
    name,
    role: "battlefield",
    // Enrichment families are filled in Phase 1–2. Flag their absence now so the
    // board shows honest coverage instead of pretending the row is complete.
    coverage_flags: {
      firmographics_missing: true,
      offpage_missing: true,
      understanding_missing: true,
    },
    source_versions: { battlefield: FIBER_BATTLEFIELD_VERSION },
  };
}

/**
 * Build the battlefield for one customer: Fiber `find-similar-companies` ->
 * normalized, deduped `company` records (role=battlefield) -> writer.
 *
 * - Normalizes every key (a non-normalized key is the #1 silent join failure).
 * - Drops the seed customer if Fiber echoes it back (it isn't part of its own
 *   battlefield; P1 already holds it as role=customer).
 * - Dedupes on normalized domain so apex/www variants collapse to one row.
 * Returns the records written (in first-seen order).
 */
export async function buildBattlefield(
  fiber: FiberClient,
  writer: CompanyWriter,
  args: BuildBattlefieldArgs,
): Promise<Company[]> {
  const seed = normalizeDomain(args.customerDomain);
  const results = await fiber.findSimilarCompanies({
    domain: seed,
    limit: args.limit,
  });

  const byDomain = new Map<string, Company>();
  for (const raw of results) {
    if (!raw?.domain) continue; // skip malformed entries rather than write a junk key
    let company: Company;
    try {
      company = toBattlefieldCompany(raw);
    } catch {
      continue; // unparseable domain -> skip (don't poison the join surface)
    }
    if (company.domain === seed) continue; // the customer isn't its own competitor
    if (!byDomain.has(company.domain)) byDomain.set(company.domain, company);
  }

  const companies = [...byDomain.values()];
  for (const company of companies) {
    await writer.upsertCompany(company);
  }
  return companies;
}
