/**
 * Domain & URL normalization — canonical implementation matching convex/lib/domain.ts.
 *
 * Ported from convex/lib/domain.ts to provide the same normalization in the
 * measurement lane. Every lane must produce the same keys for the company ↔ page
 * ↔ measurement join to work.
 *
 * CONTRACT (depended on for exact-match consistency):
 *
 *   normalizeDomain(input) -> registrable domain (eTLD+1)
 *     - accepts a BARE HOST *or* a FULL URL (scheme/path/query/fragment) and
 *       returns the same key for both.
 *     - lowercased, strips `www`, strips ALL subdomains, drops port/userinfo,
 *       collapses http/https.
 *     - multi-label public suffixes handled: `blog.acme.co.uk` -> `acme.co.uk`.
 *
 *   normalizeUrl(input) -> canonical page key
 *     - forces https, strips `www` but KEEPS meaningful subdomains,
 *       keeps the path (case-preserved) minus a trailing slash, drops the
 *       fragment and tracking params, sorts remaining query params.
 *
 * Both functions are IDEMPOTENT: f(f(x)) === f(x).
 */

/** Pragmatic subset of multi-label public suffixes (NOT the full PSL). */
const MULTI_LABEL_SUFFIXES: ReadonlySet<string> = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au",
  "co.nz", "net.nz", "org.nz", "govt.nz",
  "co.jp", "or.jp", "ne.jp", "go.jp", "ac.jp",
  "co.in", "net.in", "org.in", "gen.in", "firm.in", "ind.in",
  "co.za", "org.za", "net.za", "gov.za",
  "com.br", "net.br", "org.br", "gov.br",
  "com.mx", "com.sg", "com.hk", "com.tr", "com.cn", "com.tw",
  "co.kr", "or.kr",
]);

/** Query parameter keys (or prefixes ending in `*`) stripped from URLs. */
const TRACKING_PARAMS: ReadonlyArray<string> = [
  "utm_*", "gclid", "fbclid", "msclkid", "mc_eid", "igshid", "_hsenc", "_hsmi",
  "mkt_tok", "yclid", "_ga", "ref_src",
];

function isTrackingParam(key: string): boolean {
  const k = key.toLowerCase();
  for (const pat of TRACKING_PARAMS) {
    if (pat.endsWith("*")) {
      if (k.startsWith(pat.slice(0, -1))) return true;
    } else if (k === pat) {
      return true;
    }
  }
  return false;
}

/**
 * Extract a lowercased host from a bare host OR a full URL. Strips
 * scheme, userinfo, path/query/fragment, port, and a trailing dot.
 * Keeps subdomains (incl. `www`). Returns "" for empty/garbage input.
 */
function cleanHost(input: string): string {
  if (!input) return "";
  let s = String(input).trim().toLowerCase();
  if (!s) return "";
  // Strip scheme (`https://`, `http://`, or a leading `//`).
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^\/\//, "");
  // Authority ends at the first path/query/fragment delimiter.
  s = s.split(/[/?#]/, 1)[0];
  // Strip userinfo (`user:pass@host`).
  const at = s.lastIndexOf("@");
  if (at !== -1) s = s.slice(at + 1);
  // Strip port. (IPv6 literals are out of scope for domain keys.)
  s = s.split(":", 1)[0];
  // Strip a trailing dot (fully-qualified form).
  s = s.replace(/\.+$/, "");
  return s;
}

/** Remove a single leading `www.` label. */
function stripWww(host: string): string {
  return host.replace(/^www\./, "");
}

/**
 * Reduce a host to its registrable domain (eTLD+1), accounting for the known
 * multi-label suffixes. `blog.acme.co.uk` -> `acme.co.uk`; `acme.com` -> `acme.com`.
 * Hosts with no dot (e.g. `localhost`) or IP-like hosts are returned as-is.
 */
function registrableDomain(host: string): string {
  if (!host) return "";
  const labels = host.split(".");
  if (labels.length <= 2) return host; // already eTLD+1 (or bare/localhost)
  const lastTwo = labels.slice(-2).join(".");
  const take = MULTI_LABEL_SUFFIXES.has(lastTwo) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/**
 * Normalize any domain-or-URL input to its registrable domain key (eTLD+1).
 * This is the join key for `company.domain` and the target of P2's
 * citation-source-URL → domain mapping.
 */
export function normalizeDomain(input: string): string {
  const host = stripWww(cleanHost(input));
  return registrableDomain(host);
}

/**
 * Normalize a URL to the canonical page key used by `page.url` and
 * `measurement.page_url`. Forces https, strips `www`, keeps other subdomains and
 * the path, drops fragment + tracking params, sorts remaining params. Returns ""
 * for empty/garbage input.
 */
export function normalizeUrl(input: string): string {
  if (!input) return "";
  const raw = String(input).trim();
  if (!raw) return "";

  const host = stripWww(cleanHost(raw));
  if (!host) return "";

  // Path / query / fragment: everything after the authority.
  let rest = raw
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^\/\//, "");
  const authorityEnd = rest.search(/[/?#]/);
  rest = authorityEnd === -1 ? "" : rest.slice(authorityEnd);

  // Split off fragment (dropped) then query.
  const hashIdx = rest.indexOf("#");
  if (hashIdx !== -1) rest = rest.slice(0, hashIdx);
  let path = rest;
  let query = "";
  const qIdx = rest.indexOf("?");
  if (qIdx !== -1) {
    path = rest.slice(0, qIdx);
    query = rest.slice(qIdx + 1);
  }

  // Path: strip a single trailing slash (root path collapses to "").
  if (path === "/" || path === "") {
    path = "";
  } else {
    path = path.replace(/\/+$/, "");
  }

  // Query: drop tracking params, keep the rest, sort for determinism.
  let queryStr = "";
  if (query) {
    const kept = query
      .split("&")
      .filter((p) => p.length > 0)
      .map((p) => {
        const eq = p.indexOf("=");
        const key = eq === -1 ? p : p.slice(0, eq);
        return { raw: p, key };
      })
      .filter((p) => !isTrackingParam(p.key))
      .map((p) => p.raw)
      .sort();
    if (kept.length) queryStr = "?" + kept.join("&");
  }

  return `https://${host}${path}${queryStr}`;
}

/** True if the two inputs resolve to the same registrable-domain key. */
export function sameDomain(a: string, b: string): boolean {
  return normalizeDomain(a) === normalizeDomain(b);
}
