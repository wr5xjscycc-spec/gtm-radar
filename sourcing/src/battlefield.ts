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
import type { Company, CompanyRole } from "./types";

/**
 * The coverage stamp every Phase-1 `company` row carries: enrichment
 * (firmographics / offpage / understanding) has NOT run yet, so every family is
 * flagged missing. Centralized so battlefield + customer + competitor rows stay
 * byte-identical (a divergence here would be a silent coverage lie).
 */
function freshCoverageFlags(): Company["coverage_flags"] {
  return {
    firmographics_missing: true,
    offpage_missing: true,
    understanding_missing: true,
  };
}

/** Build a contract-shaped `company` row with a given role (normalizes the key). */
function toCompany(domain: string, name: string | undefined, role: CompanyRole): Company {
  const normalized = normalizeDomain(domain);
  return {
    domain: normalized,
    name: (name ?? "").trim() || normalized,
    role,
    coverage_flags: freshCoverageFlags(),
    // Provenance honesty: only battlefield rows came from Fiber
    // `find-similar-companies`. Customer/competitor rows are seeded from the P1
    // `customer` record, so we don't assert a Fiber provenance they never had —
    // their families get stamped later by the enrichment passes.
    source_versions: role === "battlefield" ? { battlefield: FIBER_BATTLEFIELD_VERSION } : {},
  };
}

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
  // Enrichment families are filled in Phase 1–2; their absence is flagged inside
  // toCompany so the board shows honest coverage instead of a complete-looking row.
  return toCompany(raw.domain, raw.name, "battlefield");
}

/** Known roles for a customer's battlefield, used by {@link roleFor}. */
export interface RoleContext {
  /** The customer's own domain (raw OK — normalized internally). */
  customerDomain: string;
  /** Known competitor domains (raw OK — normalized internally). */
  competitorDomains?: string[];
}

/**
 * Decide a company's role by EXPLICIT precedence: customer > competitor >
 * battlefield. Pure + normalization-safe — every input is normalized before the
 * comparison so a messy competitor URL still wins over a clean Fiber hit.
 *
 * A domain that is both a known competitor AND a Fiber "similar company" must
 * resolve to `competitor`, never `battlefield` — that's the whole point of the
 * precedence ladder (a competitor isn't a neutral battlefield bystander).
 */
export function roleFor(domain: string, ctx: RoleContext): CompanyRole {
  const target = normalizeDomain(domain);
  // Guard the customer key like we guard competitor keys: a junk/empty
  // customerDomain shouldn't throw out of a pure classifier — it just can't match.
  let customer: string | null = null;
  try {
    customer = normalizeDomain(ctx.customerDomain);
  } catch {
    customer = null;
  }
  if (customer !== null && target === customer) return "customer";
  for (const raw of ctx.competitorDomains ?? []) {
    let competitor: string;
    try {
      competitor = normalizeDomain(raw);
    } catch {
      continue; // ignore junk competitor entries rather than throw mid-classify
    }
    if (competitor === target) return "competitor";
  }
  return "battlefield";
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

export interface BuildCompanyLayerArgs {
  /** Seed customer domain (raw OK — normalized internally). */
  customerDomain: string;
  /** Optional display name for the customer row (defaults to the domain). */
  customerName?: string;
  /** Known competitor domains from the P1 `customer` record (raw OK). */
  competitorDomains?: string[];
  /** Soft cap forwarded to Fiber. Phase 1 expands to 20–40 (no hard cap below that). */
  limit?: number;
}

/**
 * Build the FULL company layer for one customer (Phase 1):
 *
 *  - the customer's own domain  -> role=customer (present in output; unlike
 *    {@link buildBattlefield}, the customer is NOT excluded here)
 *  - each known competitor       -> role=competitor (written even if Fiber never
 *    returned it — competitors are known a priori from the P1 `customer` record)
 *  - every other Fiber hit       -> role=battlefield
 *
 * Precedence is explicit (customer > competitor > battlefield): a domain that is
 * both a known competitor and a Fiber "similar company" ends up `competitor`,
 * never `battlefield`. Every key is normalized and deduped, so no domain appears
 * twice and apex/www variants collapse to one row. Coverage flags + source
 * version match Phase 0 (enrichment hasn't run yet). Returns rows in write order:
 * customer first, then competitors, then battlefield (first-seen).
 */
export async function buildCompanyLayer(
  fiber: FiberClient,
  writer: CompanyWriter,
  args: BuildCompanyLayerArgs,
): Promise<Company[]> {
  const customerDomain = normalizeDomain(args.customerDomain);
  const ctx: RoleContext = {
    customerDomain,
    competitorDomains: args.competitorDomains,
  };

  const results = await fiber.findSimilarCompanies({
    domain: customerDomain,
    limit: args.limit,
  });

  // first-seen order, with precedence enforced by seeding customer + competitors
  // BEFORE Fiber results, then skipping any Fiber domain already claimed.
  const byDomain = new Map<string, Company>();

  // 1. customer (highest precedence) — always present.
  byDomain.set(customerDomain, toCompany(customerDomain, args.customerName, "customer"));

  // 2. known competitors — written even if Fiber didn't surface them.
  for (const raw of args.competitorDomains ?? []) {
    let competitor: Company;
    try {
      competitor = toCompany(raw, undefined, "competitor");
    } catch {
      continue; // skip unparseable competitor inputs rather than write a junk key
    }
    if (!byDomain.has(competitor.domain)) byDomain.set(competitor.domain, competitor);
  }

  // 3. Fiber-discovered companies — battlefield unless precedence already claimed
  //    the domain as customer/competitor. When Fiber echoes an already-claimed
  //    domain (customer or competitor) we borrow Fiber's name to replace a
  //    domain-placeholder name, without changing the row's role.
  for (const fiberCompany of results) {
    if (!fiberCompany?.domain) continue; // skip malformed entries
    let domain: string;
    try {
      domain = normalizeDomain(fiberCompany.domain);
    } catch {
      continue; // unparseable domain -> skip (don't poison the join surface)
    }
    const existing = byDomain.get(domain);
    if (existing) {
      // Precedence holds (customer/competitor). Borrow Fiber's name only if the
      // existing row is still using the domain as a placeholder name.
      const fiberName = (fiberCompany.name ?? "").trim();
      if (fiberName && existing.name === existing.domain) existing.name = fiberName;
      continue;
    }
    byDomain.set(domain, toCompany(domain, fiberCompany.name, roleFor(domain, ctx)));
  }

  const companies = [...byDomain.values()];
  for (const company of companies) {
    await writer.upsertCompany(company);
  }
  return companies;
}
