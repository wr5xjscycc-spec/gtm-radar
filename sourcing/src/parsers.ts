// Deterministic content-feature parsers (P3 · Phase 2, task #4 — objective family).
//
// These are PURE functions over HTML/text: NO network, NO LLM, NO DOM library
// (the repo carries no jsdom/cheerio — we stay dependency-free with lightweight
// regex/string scanning). They compute the DETERMINISTIC half of `content_features`
// (types.ts → DeterministicContentFeatures): the low-measurement-error family the
// red-team says to PREFER. Subjective (gpt-4o-mini) features live in features.ts.
//
// Heuristics are intentionally simple and DOCUMENTED inline so a reviewer can see
// exactly what each boolean/number means — these feed a causal model downstream,
// so a surprising parse must be auditable, not magic.

import type { DeterministicContentFeatures, HeadingStructure } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Text extraction (shared helper)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip HTML down to rough visible text: drop <script>/<style> bodies, remove all
 * tags, decode a handful of common entities, and collapse whitespace. This is a
 * heuristic (no DOM), good enough for word counts and substring term matching.
 */
export function htmlToText(html: string): string {
  if (!html) return "";
  return html
    // Remove non-visible element bodies first (their text isn't "content").
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    // Strip all remaining tags.
    .replace(/<[^>]+>/g, " ")
    // Decode the few entities that otherwise glue/inflate word counts.
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    // Collapse whitespace.
    .replace(/\s+/g, " ")
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// schema_markup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True when the page carries structured-data markup that AI engines parse:
 *  - JSON-LD: a `<script type="application/ld+json">` block, OR
 *  - schema.org microdata: an `itemscope` paired with an `itemtype` that points
 *    at schema.org.
 * Either signal counts. Attribute quoting/spacing is tolerated.
 */
export function hasSchemaMarkup(html: string): boolean {
  if (!html) return false;
  // Tolerate a parameterized media type, e.g. `application/ld+json; charset=utf-8`
  // (some CMSs emit this) — match the type token, then any trailing params.
  const jsonLd = /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json\b[^"']*["'][^>]*>/i.test(html);
  if (jsonLd) return true;
  const microdata =
    /\bitemscope\b/i.test(html) && /\bitemtype\s*=\s*["'][^"']*schema\.org/i.test(html);
  return microdata;
}

// ─────────────────────────────────────────────────────────────────────────────
// comparison_table
// ─────────────────────────────────────────────────────────────────────────────

/** Pull each `<table>…</table>` block out of the HTML (case-insensitive, dotall). */
function extractTables(html: string): string[] {
  return html.match(/<table\b[\s\S]*?<\/table>/gi) ?? [];
}

/** Count occurrences of an opening tag like `<th` / `<tr` (boundary-safe). */
function countOpenTags(html: string, tag: string): number {
  const re = new RegExp(`<${tag}\\b`, "gi");
  return (html.match(re) ?? []).length;
}

/**
 * True when the page contains at least one table that LOOKS like a
 * comparison/feature matrix rather than a layout table.
 *
 * Heuristic (documented): a table qualifies when it has a real HEADER — a
 * `<thead>` or `<th>` cells — defining **>= 3 columns** (a feature/label column
 * plus two-or-more compared options) AND at least **2 body rows** (`<tr>` that
 * carry `<td>` data cells). Rationale:
 *  - Layout tables (old-school page scaffolding) use only `<td>`, never `<th>` —
 *    requiring a header excludes them.
 *  - A 2-column "Term / Definition" table has a header but only 1 compared
 *    column, so it is NOT a comparison table (we require >= 3 columns).
 * The 3-column / 2-row thresholds are the judgment call; documented here.
 */
export function hasComparisonTable(html: string): boolean {
  if (!html) return false;
  for (const table of extractTables(html)) {
    if (!/<th\b/i.test(table)) continue; // no header cells → treat as layout/data, skip

    // Header columns: count <th> in the first row that contains any <th>.
    const headerRow = (table.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? []).find((r) => /<th\b/i.test(r));
    const headerCols = headerRow ? countOpenTags(headerRow, "th") : 0;

    // Body rows: <tr> rows that carry <td> data cells (exclude pure header rows).
    const bodyRows = (table.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? []).filter(
      (r) => /<td\b/i.test(r),
    ).length;

    if (headerCols >= 3 && bodyRows >= 2) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// word_count
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Visible-text word count. Accepts either already-extracted text OR raw HTML
 * (we defensively strip tags so the function is robust to either input). Words
 * are whitespace-delimited non-empty tokens.
 */
export function wordCount(text: string): number {
  if (!text) return 0;
  // If it still looks like HTML, reduce to visible text first.
  const visible = /<[^>]+>/.test(text) ? htmlToText(text) : text;
  const tokens = visible.trim().split(/\s+/).filter((t) => t.length > 0);
  return tokens.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// heading_structure
// ─────────────────────────────────────────────────────────────────────────────

/** Counts of opening <h1>/<h2>/<h3> tags — a deterministic document-structure proxy. */
export function headingStructure(html: string): HeadingStructure {
  return {
    h1: countOpenTags(html ?? "", "h1"),
    h2: countOpenTags(html ?? "", "h2"),
    h3: countOpenTags(html ?? "", "h3"),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// freshness_days
// ─────────────────────────────────────────────────────────────────────────────

function toDate(value: string | Date | null | undefined): Date | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(String(value).trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Whole days between a published/modified date and `now`. `now` is INJECTED
 * (ISO string or Date) so tests are deterministic — we never read the wall clock.
 *
 * Returns `null` when the date (or now) is missing/unparseable. A future date
 * (modified > now) clamps to 0 rather than going negative: "days since update"
 * is not meaningfully negative, and a clamp keeps the feature non-negative for
 * the model. Result is `Math.floor`ed to whole days.
 */
export function freshnessDays(
  input: string | Date | null | undefined,
  now: string | Date,
): number | null {
  const updated = toDate(input);
  const ref = toDate(now);
  if (updated === null || ref === null) return null;
  const days = Math.floor((ref.getTime() - updated.getTime()) / MS_PER_DAY);
  return days < 0 ? 0 : days;
}

/**
 * Best-effort extraction of a last-modified/published timestamp from HTML meta or
 * a `<time datetime>` element. Checks (in order) the common machine-readable
 * tags. Returns an ISO-ish string or null. Used only as a FALLBACK when the
 * caller didn't pass an explicit `lastModified`.
 */
export function extractLastModified(html: string): string | null {
  if (!html) return null;
  const patterns: RegExp[] = [
    /<meta\b[^>]*\bproperty\s*=\s*["']article:modified_time["'][^>]*\bcontent\s*=\s*["']([^"']+)["']/i,
    /<meta\b[^>]*\bproperty\s*=\s*["']og:updated_time["'][^>]*\bcontent\s*=\s*["']([^"']+)["']/i,
    /<meta\b[^>]*\bproperty\s*=\s*["']article:published_time["'][^>]*\bcontent\s*=\s*["']([^"']+)["']/i,
    /<meta\b[^>]*\bname\s*=\s*["'](?:date|last-modified|dcterms\.modified)["'][^>]*\bcontent\s*=\s*["']([^"']+)["']/i,
    /<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1] && m[1].trim()) return m[1].trim();
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// query_term_coverage
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True if a single query term appears in the (already-lowercased) page text.
 *
 * Single-token terms match on WORD BOUNDARIES so a short token like "ai" doesn't
 * spuriously match inside "email" — this is a deterministic feature the model is
 * told to "prefer" as low-noise, so substring inflation would undermine it.
 * Multi-word phrases keep plain substring matching (internal spacing makes a
 * boundary regex brittle, and a phrase match is already specific).
 */
function termAppears(haystack: string, term: string): boolean {
  if (/\s/.test(term)) return haystack.includes(term);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Boundary = start/end or any non-alphanumeric char (linear, no ReDoS).
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`).test(haystack);
}

/**
 * Fraction (0..1) of DISTINCT query terms that appear (case-insensitive) in the
 * page text. Terms are lowercased + trimmed; blanks dropped; duplicates collapsed.
 * Single-token terms match on word boundaries (see {@link termAppears}).
 *
 * Convention: an empty term list (or one with only blanks) → 0. There is no
 * coverage to claim when nothing was asked, and 0 is the safe "no signal" value
 * for the model (a NaN from 0/0 would poison downstream math).
 */
export function queryTermCoverage(text: string, queryTerms: string[]): number {
  const haystack = (text ?? "").toLowerCase();
  const distinct = Array.from(
    new Set((queryTerms ?? []).map((t) => (t ?? "").trim().toLowerCase()).filter((t) => t.length > 0)),
  );
  if (distinct.length === 0) return 0;
  const hits = distinct.filter((term) => termAppears(haystack, term)).length;
  return hits / distinct.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

export interface DeterministicFeatureInput {
  /** Raw page HTML (required — most parsers read structure). */
  html: string;
  /** Pre-extracted visible text; derived from `html` when omitted. */
  text?: string;
  /** Explicit published/modified date; falls back to HTML meta when omitted. */
  lastModified?: string | Date | null;
  /** Query terms for coverage (empty/omitted → coverage 0). */
  queryTerms?: string[];
}

/**
 * Run every deterministic parser into the typed DeterministicContentFeatures
 * vector. `now` is injected for reproducible freshness. This is the always-present
 * half of `content_features` (the subjective half is optional / merged later).
 */
export function extractDeterministicFeatures(
  input: DeterministicFeatureInput,
  now: string | Date,
): DeterministicContentFeatures {
  const text = input.text ?? htmlToText(input.html);
  const lastModified =
    input.lastModified != null ? input.lastModified : extractLastModified(input.html);
  return {
    schema_markup: hasSchemaMarkup(input.html),
    comparison_table: hasComparisonTable(input.html),
    word_count: wordCount(text),
    heading_structure: headingStructure(input.html),
    freshness_days: freshnessDays(lastModified, now),
    query_term_coverage: queryTermCoverage(text, input.queryTerms ?? []),
  };
}
