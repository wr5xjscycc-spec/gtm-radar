// Domain & URL normalization — ported from convex/lib/domain.ts (P1 canonical helper).
//
// CONTRACT: every lane keys records on the output of these functions. A non-normalized
// key is the #1 silent-failure mode: `company` ↔ `page` joins break invisibly when
// one lane writes `www.acme.com` and another writes `acme.com`.
//
// normalizeDomain(input) -> registrable domain (eTLD+1)
//   - Accepts a bare host OR a full URL and returns the same key for both.
//   - Lowercased, strips `www`, strips ALL subdomains, drops port/userinfo,
//     collapses http/https. `https://www.Acme.com/pricing?x=1` and `acme.com`
//     both -> `acme.com`. `docs.acme.com` -> `acme.com`.
//   - Multi-label public suffixes handled: `blog.acme.co.uk` -> `acme.co.uk`.
//   - Returns "" for empty/garbage input (never throws).
//
// normalizeUrl(input) -> canonical page key
//   - Forces https, strips `www` but KEEPS meaningful subdomains, keeps the path
//     (case-preserved) minus trailing slash, drops fragment + tracking params,
//     sorts remaining query params for determinism.
//   - Returns "" for empty/garbage input.

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

/** Extract a lowercased host from a bare host OR a full URL. */
function cleanHost(input: string): string {
  if (!input) return "";
  let s = String(input).trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^\/\//, "");
  s = s.split(/[/?#]/, 1)[0];
  const at = s.lastIndexOf("@");
  if (at !== -1) s = s.slice(at + 1);
  s = s.split(":", 1)[0];
  s = s.replace(/\.+$/, "");
  return s;
}

/** Remove a single leading `www.` label. */
function stripWww(host: string): string {
  return host.replace(/^www\./, "");
}

/** Reduce a host to its registrable domain (eTLD+1). */
function registrableDomain(host: string): string {
  if (!host) return "";
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join(".");
  const take = MULTI_LABEL_SUFFIXES.has(lastTwo) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/**
 * Normalize any domain-or-URL input to its registrable domain key (eTLD+1).
 * Returns "" for empty/garbage input.
 */
export function normalizeDomain(input: string): string {
  const host = stripWww(cleanHost(input));
  return registrableDomain(host);
}

/**
 * Normalize a URL to the canonical page key. Forces https, strips `www`,
 * keeps other subdomains and the path, drops fragment + tracking params,
 * sorts remaining params. Returns "" for empty/garbage input.
 */
export function normalizeUrl(input: string): string {
  if (!input) return "";
  const raw = String(input).trim();
  if (!raw) return "";

  const host = stripWww(cleanHost(raw));
  if (!host) return "";

  let rest = raw
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^\/\//, "");
  const authorityEnd = rest.search(/[/?#]/);
  rest = authorityEnd === -1 ? "" : rest.slice(authorityEnd);

  const hashIdx = rest.indexOf("#");
  if (hashIdx !== -1) rest = rest.slice(0, hashIdx);
  let path = rest;
  let query = "";
  const qIdx = rest.indexOf("?");
  if (qIdx !== -1) {
    path = rest.slice(0, qIdx);
    query = rest.slice(qIdx + 1);
  }

  if (path === "/" || path === "") {
    path = "";
  } else {
    path = path.replace(/\/+$/, "");
  }

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

/** True when `input` already equals its normalized form AND is non-empty. */
export function isNormalizedDomain(input: string): boolean {
  if (!input) return false;
  return normalizeDomain(input) === input;
}
