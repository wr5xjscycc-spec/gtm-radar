// Fiber adapter — the battlefield source.
//
// Fiber is reached via MCP (`find-similar-companies`). Per docs/TESTING.md rule 1
// the network call is NEVER made in tests: this module defines a PORT
// (`FiberClient`) that the battlefield builder depends on, so unit tests inject a
// mock returning the recorded shape in tests/fixtures/, and the real MCP-backed
// client is a thin wrapper supplied at the app edge (Convex action, P1 wiring).

/** One company as returned by Fiber `find-similar-companies` (the fields we consume). */
export interface FiberCompany {
  /** Company website — may arrive as a bare domain or a full URL; we normalize on write. */
  domain: string;
  name: string;
  /** Fiber's category/label for the seed match, if present (informational only in Phase 0). */
  category?: string;
}

/** Arguments for a battlefield lookup. */
export interface FindSimilarArgs {
  /** Seed customer domain (raw is fine — the client/builder normalizes). */
  domain: string;
  /** Soft cap on results. Phase 0 proves one battlefield; Phase 1 expands to 20–40. */
  limit?: number;
}

/**
 * The Fiber port. The real implementation calls the Fiber MCP tool
 * `find-similar-companies`; tests pass a mock. Keeping this an interface is what
 * lets CI stay deterministic and free (no live vendor calls).
 */
export interface FiberClient {
  findSimilarCompanies(args: FindSimilarArgs): Promise<FiberCompany[]>;
}

/** Stable version tag stamped into `company.source_versions.battlefield`. */
export const FIBER_BATTLEFIELD_VERSION = "fiber/find-similar-companies@v1";

/**
 * Shape of a raw Fiber `find-similar-companies` payload (what the MCP tool returns
 * before we map it). Modeled loosely so a real recorded fixture can be replayed.
 */
export interface FiberFindSimilarResponse {
  companies: FiberCompany[];
}

/** Pull the company list out of a (possibly wrapped) Fiber response, tolerantly. */
export function parseFiberResponse(raw: FiberFindSimilarResponse | FiberCompany[]): FiberCompany[] {
  const list = Array.isArray(raw) ? raw : raw?.companies;
  if (!Array.isArray(list)) {
    throw new Error("parseFiberResponse: Fiber payload had no `companies` array");
  }
  return list;
}
