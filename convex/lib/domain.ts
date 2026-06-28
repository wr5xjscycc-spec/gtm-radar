/**
 * Domain & URL normalization — the single cross-lane join primitive (owner: P1).
 *
 * EVERY lane keys records on the output of these functions. They are the only
 * sanctioned way to produce a domain/URL key. A non-normalized key is the #1
 * silent-failure mode in this system: `company` ↔ `page` ↔ `measurement` joins
 * break invisibly when one lane writes `www.acme.com` and another writes
 * `acme.com`. Enforced in the Convex mutation layer (see ../records.ts), not by
 * convention.
 *
 * CONTRACT (depended on for exact-match consistency by P2/P3/P4):
 *
 *   normalizeDomain(input) -> registrable domain (eTLD+1)
 *     - accepts a BARE HOST *or* a FULL URL (scheme/path/query/fragment) and
 *       returns the same key for both. This is load-bearing: P2 calls it on
 *       OpenAI/Perplexity/Gemini citation *source URLs*, P3 writes
 *       `company.domain` from a host — they must collide.
 *     - lowercased, strips `www`, strips ALL subdomains, drops port/userinfo,
 *       collapses http/https. `https://www.Acme.com/pricing?x=1` and `acme.com`
 *       both -> `acme.com`. `docs.acme.com` -> `acme.com`.
 *     - multi-label public suffixes handled: `blog.acme.co.uk` -> `acme.co.uk`
 *       (NOT `co.uk`). The suffix set below is a pragmatic demo subset, not the
 *       full Mozilla Public Suffix List — see LIMITATION.
 *
 *   normalizeUrl(input) -> canonical page key (for `page.url` AND
 *                          `measurement.page_url` — they must collide)
 *     - forces https, strips `www` but KEEPS meaningful subdomains
 *       (`docs.acme.com` ≠ `acme.com`), keeps the path (case-preserved) minus a
 *       trailing slash, drops the fragment and tracking params
 *       (`utm_*`, `gclid`, `fbclid`, `msclkid`, `mc_eid`, `igshid`, `_hsenc`,
 *       `_hsmi`), sorts remaining query params for determinism.
 *
 * Both functions are IDEMPOTENT: f(f(x)) === f(x).
 *
 * REDIRECTS: live redirect resolution requires the network and therefore lives
 * in the Convex *action* layer (actions may do I/O; queries/mutations may not).
 * The action resolves to the final URL, then hands that URL to these helpers for
 * the canonical key. These pure helpers only perform deterministic alias
 * collapse (http↔https, trailing slash, `www`, case) — never a network call.
 *
 * LIMITATION: `MULTI_LABEL_SUFFIXES` is a hardcoded subset sufficient for the
 * demo's verticals. A registrable domain under an unlisted multi-label suffix
 * (e.g. some `*.k12.*.us`) will over-collapse. Swap in `tldts`/`psl` before any
 * locale where that matters. This is a deliberate, documented tradeoff.
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
  // IPv4-like all-numeric hosts aren't registrable domains; return unchanged so
  // "192.168.1.1" isn't truncated to "1.1". Explicit [0-9] keeps JS/Python in sync.
  if (labels.every((l) => /^[0-9]+$/.test(l))) return host;
  if (labels.length <= 2) return host; // already eTLD+1 (or bare/localhost)
  const lastTwo = labels.slice(-2).join(".");
  const take = MULTI_LABEL_SUFFIXES.has(lastTwo) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/**
 * Normalize any domain-or-URL input to its registrable domain key (eTLD+1).
 * This is the join key for `company.domain` and the target of P2's
 * citation-source-URL → domain mapping. See CONTRACT above.
 */
export function normalizeDomain(input: string): string {
  const host = stripWww(cleanHost(input));
  return registrableDomain(host);
}

/**
 * Normalize a URL to the canonical page key used by `page.url` and
 * `measurement.page_url`. Forces https, strips `www`, keeps other subdomains and
 * the path, drops fragment + tracking params, sorts remaining params. See
 * CONTRACT above. Returns "" for empty/garbage input.
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
