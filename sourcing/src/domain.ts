// Domain normalization — LANE-LOCAL PLACEHOLDER.
//
// CONTRACT (docs/CONTRACT.md, Global rules): keys are normalized domains.
// "Lowercase, strip `www`, strip subdomain where appropriate, resolve redirects.
//  P1 owns the single normalization helper; every lane uses it."
//
// P1·0 has not shipped that helper yet. Per docs/CONTRACT.md §Fixtures
// ("code against its fixture and note the assumption in your PR") this module
// is a stand-in that implements the deterministic, no-network subset of the
// spec so P3·0 can write contract-shaped keys today. When P1's helper lands,
// every call site here should switch to it (see ASSUMPTION note in the PR).
//
// Deliberately OUT OF SCOPE for this placeholder (needs P1 + network):
//  - subdomain stripping beyond `www` (correct stripping needs a public-suffix
//    list, e.g. `blog.example.co.uk` -> `example.co.uk`, not `co.uk`)
//  - redirect resolution (http->https, apex<->www) — that's a network step P1 owns
// We strip `www` only and leave other hosts intact rather than corrupt keys.

/**
 * Normalize a domain or URL to the canonical join key used across lanes.
 *
 * Accepts bare domains (`Example.com`), URLs (`https://www.Example.com/path?q=1`),
 * and values with ports or trailing dots. Returns the lowercased registrable host
 * with `www.` and a trailing dot removed. Throws on empty/unparseable input so a
 * bad key fails loudly at write time instead of silently breaking joins later.
 */
export function normalizeDomain(input: string): string {
  if (input == null) throw new Error("normalizeDomain: received null/undefined");
  let s = String(input).trim().toLowerCase();
  if (s === "") throw new Error("normalizeDomain: received empty string");

  // Strip scheme if present (http://, https://, //).
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^\/\//, "");

  // Drop everything from the first path/query/fragment separator.
  s = s.split(/[/?#]/, 1)[0];

  // Strip userinfo (user:pass@host) and port.
  s = s.replace(/^[^@]*@/, "").replace(/:\d+$/, "");

  // Strip a single trailing dot (FQDN root) and a leading www.
  s = s.replace(/\.$/, "").replace(/^www\./, "");

  if (s === "") throw new Error(`normalizeDomain: nothing left after normalizing "${input}"`);
  return s;
}

/** True when `input` already equals its normalized form (useful in write-time asserts). */
export function isNormalizedDomain(input: string): boolean {
  try {
    return normalizeDomain(input) === input;
  } catch {
    return false;
  }
}
