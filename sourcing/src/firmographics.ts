// Firmographics / context enrichment (P3 · Phase 1 · task #3).
//
// Fills `company.firmographics` (contract record #2) from Fiber's
// firmographics/enrichment endpoint: size, funding_stage, headcount_growth,
// hiring_velocity, tech_stack.
//
// Red-team gotcha (P3 phase card): the context-feature family is DELIBERATELY
// SMALL and clearly company-level — effective N = #companies (~20–40), so this
// module maps ONLY the five contract fields and DROPS anything else Fiber
// returns. Do not let the family grow.
//
// Like src/fiber.ts, Fiber is reached via MCP and is NEVER called in tests:
// this module defines its own PORT (`FiberFirmographicsClient`) that the
// enricher depends on, so unit tests inject a mock and the real MCP-backed
// client is supplied at the app edge (P1 wiring). No network, no real SDK here.

import type { Company, Firmographics } from "./types";

/**
 * Raw payload from Fiber's firmographics/enrichment endpoint (modeled loosely so
 * a recorded fixture can be replayed). The five contract fields are typed; extra
 * raw fields Fiber may return are allowed but intentionally ignored by the mapper.
 */
export interface FiberFirmographicsResponse {
  size?: string;
  funding_stage?: string;
  headcount_growth?: string;
  hiring_velocity?: string;
  /** Fiber may return an array, or a comma-separated string — both normalized. */
  tech_stack?: string[] | string;
  /** Extra raw fields are tolerated on the wire but DROPPED by mapFirmographics. */
  [extra: string]: unknown;
}

/**
 * The Fiber firmographics port. The real implementation calls the Fiber MCP
 * enrichment tool; tests pass a mock. Keeping this an interface is what lets CI
 * stay deterministic and free (no live vendor calls).
 */
export interface FiberFirmographicsClient {
  getFirmographics(args: { domain: string }): Promise<FiberFirmographicsResponse>;
}

/** Stable version tag stamped into `company.source_versions.firmographics`. */
export const FIBER_FIRMOGRAPHICS_VERSION = "fiber/firmographics@v1";

/**
 * Normalize Fiber's `tech_stack` to a clean `string[]`:
 * - array  -> trimmed, empties dropped
 * - string -> split on commas, trimmed, empties dropped
 * - absent -> undefined
 * Returns undefined (rather than an empty array) when nothing usable is present,
 * so a missing field stays missing instead of polluting with `[]`.
 */
function normalizeTechStack(raw: string[] | string | undefined): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const parts = Array.isArray(raw) ? raw : String(raw).split(",");
  const cleaned = parts
    .map((p) => (typeof p === "string" ? p : String(p)).trim())
    .filter((p) => p.length > 0);
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Drop empty/blank string values so absent fields stay `undefined`, not "". */
function cleanString(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Map Fiber's raw response to the contract `Firmographics` shape.
 *
 * Maps ONLY the five contract fields and DROPS every other field Fiber returns
 * (family-stays-small invariant). Missing fields are left `undefined`. The
 * returned object only carries keys that have a value, so a sparse Fiber
 * response yields a sparse (but still valid) Firmographics.
 */
export function mapFirmographics(raw: FiberFirmographicsResponse): Firmographics {
  const out: Firmographics = {};

  const size = cleanString(raw.size);
  if (size !== undefined) out.size = size;

  const funding_stage = cleanString(raw.funding_stage);
  if (funding_stage !== undefined) out.funding_stage = funding_stage;

  const headcount_growth = cleanString(raw.headcount_growth);
  if (headcount_growth !== undefined) out.headcount_growth = headcount_growth;

  const hiring_velocity = cleanString(raw.hiring_velocity);
  if (hiring_velocity !== undefined) out.hiring_velocity = hiring_velocity;

  const tech_stack = normalizeTechStack(raw.tech_stack);
  if (tech_stack !== undefined) out.tech_stack = tech_stack;

  return out;
}

/**
 * Enrich one `company` with firmographics from Fiber.
 *
 * Calls Fiber with the company's ALREADY-NORMALIZED domain (the join key — never
 * re-normalized or altered here), then returns a COPY of the company with
 * `firmographics` set from the mapped response.
 *
 * COVERAGE HONESTY (red-team transparency rule): the `firmographics_missing` flag
 * is flipped to `false` and the source version stamped ONLY when Fiber actually
 * returned at least one usable field. An empty/blank Fiber response leaves the
 * row flagged missing and unstamped — we never claim coverage we don't have.
 * The input company is never mutated; all other fields/flags are preserved.
 */
export async function enrichFirmographics(
  fiber: FiberFirmographicsClient,
  company: Company,
): Promise<Company> {
  const raw = await fiber.getFirmographics({ domain: company.domain });
  const firmographics = mapFirmographics(raw);
  const populated = Object.keys(firmographics).length > 0;

  return {
    ...company,
    firmographics,
    coverage_flags: {
      ...company.coverage_flags,
      firmographics_missing: !populated,
    },
    source_versions: {
      ...company.source_versions,
      // Only assert firmographics provenance when we actually have data.
      ...(populated ? { firmographics: FIBER_FIRMOGRAPHICS_VERSION } : {}),
    },
  };
}
