// TEMP: in-lane stand-in for P1's single shared domain-normalization helper.
// TODO(P1·0): replace every import of this with P1's helper once convex/ lands it.
// See docs/CONTRACT.md "Global rules" and ORCHESTRATION.md §4 (the contract is sacred).
//
// Conservative by design: lowercase, drop protocol/path/query/port, strip a leading "www."
// We deliberately do NOT strip arbitrary subdomains (that needs a public-suffix list) and do
// NOT resolve redirects (needs network) — both belong in P1's real helper. Over-stripping a
// subdomain silently breaks the company↔page↔measurement join, the contract's #1 failure mode,
// so we prefer to under-strip here.

/**
 * Normalize a URL or bare domain to a canonical domain key.
 * Returns "" for empty/garbage input (never throws — callers join on the result).
 */
export function normalizeDomain(input: string): string {
  if (!input) return "";
  let host = input.trim();
  if (!host) return "";

  // Extract the host from a full URL when a scheme (or scheme-relative //) is present.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host) || host.startsWith("//")) {
    try {
      const withScheme = host.startsWith("//") ? `http:${host}` : host;
      host = new URL(withScheme).hostname;
    } catch {
      // fall through to bare-host handling below
    }
  }

  // Bare host: drop anything from the first path/query/fragment separator onward.
  host = host.split(/[/?#]/)[0] ?? "";
  // Drop an explicit port.
  host = host.split(":")[0] ?? "";
  host = host.toLowerCase();
  // Drop a trailing dot (fully-qualified domain form).
  host = host.replace(/\.$/, "");
  // Strip a single leading "www.".
  host = host.replace(/^www\./, "");

  return host;
}
