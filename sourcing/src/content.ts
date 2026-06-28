import { normalizeUrl } from "../../convex/lib/domain";

interface PageCacheLike {
  get(url: string, extractorVersion: string): Promise<PageRecord | null>;
  set(url: string, extractorVersion: string, html: string, page: PageRecord): Promise<void>;
}

export interface ContentFeatures {
  schema_markup: boolean;
  comparison_table: boolean;
  word_count: number;
  heading_structure: string;
  freshness_days: number | null;
  query_term_coverage: number | null;
  direct_answer_first: boolean;
  stats_density: "none" | "low" | "medium" | "high";
  citation_density: "none" | "low" | "medium" | "high";
  quote_density: "none" | "low" | "medium" | "high";
  listicle_vs_prose: "listicle" | "prose" | "mixed";
}

export interface PageRecord {
  company_domain: string;
  url: string;
  role: "candidate" | "customer" | "competitor";
  content_features: ContentFeatures;
  extractor_version: string;
  scraped_at: string;
  cache_key: string;
}

const EXTRACTOR_VERSION = "extractor-2026.06-v2";

export interface AgreementResult {
  overall_agreement: number;
  per_field: {
    direct_answer_first: number;
    stats_density: number;
    citation_density: number;
    quote_density: number;
  };
  n_samples: number;
  agreement_version: string;
}

function visibleText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractWordCount(html: string): number {
  const text = visibleText(html);
  if (!text) return 0;
  return text.split(/\s+/).length;
}

function extractSchemaMarkup(html: string): boolean {
  return /<script[^>]*type=["']application\/ld\+json["'][^>]*>/i.test(html);
}

function extractComparisonTable(html: string): boolean {
  const tableRegex = /<table[\s>]/i;
  if (!tableRegex.test(html)) return false;
  const text = visibleText(html).toLowerCase();
  const compareWords = [
    "vs", "versus", "vs.", "alternative", "compare", "comparison",
    "better", "pricing", "features", "pros", "cons",
  ];
  return compareWords.some((w) => text.includes(w));
}

function extractHeadingStructure(html: string): string {
  const counts: Record<string, number> = { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 };
  for (const tag of Object.keys(counts)) {
    const regex = new RegExp(`<${tag}[\\s>]`, "gi");
    const matches = html.match(regex);
    counts[tag] = matches ? matches.length : 0;
  }
  const parts: string[] = [];
  for (const tag of Object.keys(counts)) {
    if (counts[tag] > 0) parts.push(`${tag}:${counts[tag]}`);
  }
  return parts.join(" ") || "none";
}

function extractFreshnessDays(html: string): number | null {
  const dateRegex =
    /\b(20[2-9][0-9])[-/](0[1-9]|1[0-2])[-/](0[1-9]|[12]\d|3[01])\b/g;
  const matches = html.match(dateRegex);
  if (!matches) return null;

  const now = Date.now();
  let minDays: number | null = null;
  for (const m of matches) {
    const parsed = new Date(m);
    if (isNaN(parsed.getTime())) continue;
    const diff = Math.floor((now - parsed.getTime()) / (1000 * 60 * 60 * 24));
    if (diff >= 0 && (minDays === null || diff < minDays)) {
      minDays = diff;
    }
  }
  return minDays;
}

function extractQueryTermCoverage(
  html: string,
  queryTerms?: string[]
): number | null {
  if (!queryTerms || queryTerms.length === 0) return null;
  const text = visibleText(html).toLowerCase();
  let matched = 0;
  for (const term of queryTerms) {
    if (text.includes(term.toLowerCase())) matched++;
  }
  return matched / queryTerms.length;
}

function extractListicleVsProse(html: string): "listicle" | "prose" | "mixed" {
  const olCount = (html.match(/<ol[\s>]/gi) || []).length;
  const ulCount = (html.match(/<ul[\s>]/gi) || []).length;
  const liCount = (html.match(/<li[\s>]/gi) || []).length;
  const totalLists = olCount + ulCount;
  if (totalLists === 0) return "prose";
  if (liCount > 10) return "listicle";
  if (liCount > 3) return "mixed";
  return "prose";
}

export function extractContentFeatures(
  html: string,
  queryTerms?: string[]
): ContentFeatures {
  return {
    schema_markup: extractSchemaMarkup(html),
    comparison_table: extractComparisonTable(html),
    word_count: extractWordCount(html),
    heading_structure: extractHeadingStructure(html),
    freshness_days: extractFreshnessDays(html),
    query_term_coverage: extractQueryTermCoverage(html, queryTerms),
    direct_answer_first: false,
    stats_density: "none",
    citation_density: "none",
    quote_density: "none",
    listicle_vs_prose: extractListicleVsProse(html),
  };
}

export interface SubjectiveFeatures {
  direct_answer_first: boolean;
  stats_density: "none" | "low" | "medium" | "high";
  citation_density: "none" | "low" | "medium" | "high";
  quote_density: "none" | "low" | "medium" | "high";
}

const SUBJECTIVE_PROMPT = `Analyze this webpage content and return ONLY valid JSON with these fields:
- "direct_answer_first": boolean — does the first ~200 words directly answer a likely search query?
- "stats_density": "none" | "low" | "medium" | "high" — how dense are statistics/numbers in the content?
- "citation_density": "none" | "low" | "medium" | "high" — how dense are external citations/links?
- "quote_density": "none" | "low" | "medium" | "high" — how dense are quoted statements?`;

export async function extractSubjectiveFeatures(
  html: string,
  apiKey: string
): Promise<SubjectiveFeatures> {
  const text = visibleText(html).slice(0, 4000);

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SUBJECTIVE_PROMPT },
        { role: "user", content: `Webpage content:\n\n${text}` },
      ],
      temperature: 0.1,
      max_tokens: 300,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `OpenAI API error: ${res.status}${body ? ` — ${body.slice(0, 300)}` : ""}`
    );
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned empty response");

  const cleaned = content.replace(/```json\s*/gi, "").replace(/```\s*$/gm, "").trim();
  const parsed = JSON.parse(cleaned) as Partial<SubjectiveFeatures>;

  return {
    direct_answer_first: parsed.direct_answer_first ?? false,
    stats_density: parsed.stats_density ?? "none",
    citation_density: parsed.citation_density ?? "none",
    quote_density: parsed.quote_density ?? "none",
  };
}

export function mergeFeatures(
  det: ContentFeatures,
  subj: SubjectiveFeatures
): ContentFeatures {
  return { ...det, ...subj };
}

export async function runAgreementCheck(
  htmlSamples: string[],
  apiKey: string
): Promise<AgreementResult> {
  if (htmlSamples.length === 0) {
    return {
      overall_agreement: 1,
      per_field: {
        direct_answer_first: 1,
        stats_density: 1,
        citation_density: 1,
        quote_density: 1,
      },
      n_samples: 0,
      agreement_version: EXTRACTOR_VERSION,
    };
  }

  let directMatch = 0;
  let statsMatch = 0;
  let citationMatch = 0;
  let quoteMatch = 0;
  let total = 0;

  for (const html of htmlSamples) {
    const run1 = await extractSubjectiveFeatures(html, apiKey);
    const run2 = await extractSubjectiveFeatures(html, apiKey);

    if (run1.direct_answer_first === run2.direct_answer_first) directMatch++;
    if (run1.stats_density === run2.stats_density) statsMatch++;
    if (run1.citation_density === run2.citation_density) citationMatch++;
    if (run1.quote_density === run2.quote_density) quoteMatch++;
    total++;
  }

  const n = total;
  const perField = {
    direct_answer_first: n > 0 ? directMatch / n : 1,
    stats_density: n > 0 ? statsMatch / n : 1,
    citation_density: n > 0 ? citationMatch / n : 1,
    quote_density: n > 0 ? quoteMatch / n : 1,
  };

  const overall =
    (perField.direct_answer_first +
      perField.stats_density +
      perField.citation_density +
      perField.quote_density) /
    4;

  return {
    overall_agreement: overall,
    per_field: perField,
    n_samples: n,
    agreement_version: EXTRACTOR_VERSION,
  };
}

export function buildCacheKey(url: string, extractorVer: string): string {
  return `${normalizeUrl(url)}::${extractorVer}`;
}

export async function enrichPage(
  companyDomain: string,
  pageUrl: string,
  role: PageRecord["role"],
  apiKey: string,
  queryTerms?: string[]
): Promise<PageRecord> {
  const normalizedUrl = normalizeUrl(pageUrl);
  if (!normalizedUrl) throw new Error(`Invalid URL: ${pageUrl}`);

  const res = await fetch(normalizedUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; GTM-Radar/1.0; +https://gtmradar.com)",
      Accept: "text/html",
    },
    redirect: "follow",
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch ${normalizedUrl}: ${res.status}`);
  }

  const html = await res.text();
  const det = extractContentFeatures(html, queryTerms);
  const subj = await extractSubjectiveFeatures(html, apiKey);
  const features = mergeFeatures(det, subj);
  const scrapedAt = new Date().toISOString();

  return {
    company_domain: companyDomain,
    url: normalizedUrl,
    role,
    content_features: features,
    extractor_version: EXTRACTOR_VERSION,
    scraped_at: scrapedAt,
    cache_key: buildCacheKey(normalizedUrl, EXTRACTOR_VERSION),
  };
}

export async function enrichPageWithCache(
  companyDomain: string,
  pageUrl: string,
  role: PageRecord["role"],
  apiKey: string,
  cache: PageCacheLike,
  queryTerms?: string[]
): Promise<PageRecord> {
  const cached = await cache.get(pageUrl, EXTRACTOR_VERSION);
  if (cached) return cached;

  const page = await enrichPage(companyDomain, pageUrl, role, apiKey, queryTerms);
  await cache.set(pageUrl, EXTRACTOR_VERSION, page.scraped_at, page);
  return page;
}

export { EXTRACTOR_VERSION };
