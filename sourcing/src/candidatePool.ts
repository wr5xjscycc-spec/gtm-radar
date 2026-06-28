import { normalizeDomain, normalizeUrl } from "../../convex/lib/domain";

export interface CandidatePoolItem {
  company_domain: string;
  page_url: string;
}

const CANDIDATE_POOL_VERSION = "candidate-pool-2026.06-v1";

interface Annotation {
  type: string;
  url?: string;
  title?: string;
}

interface ContentPart {
  type: string;
  text?: string;
  annotations?: Annotation[];
}

interface ResponseOutput {
  type: string;
  role?: string;
  content?: ContentPart[];
}

interface OpenAIResponseData {
  id?: string;
  output?: ResponseOutput[];
}

const SEARCH_PROMPT_TEMPLATE = `Search for the following query and return the top 10-15 actual search result URLs (the pages that rank for this search). List each result on a new line with the format: URL: <full url>

Query: "%s"

Important: Return real, actual search result URLs that appear in the search results.`;

function extractUrlsFromText(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s)\]'"<>]+/g;
  const matches = text.match(urlRegex);
  if (!matches) return [];
  const seen = new Set<string>();
  return matches.filter((u) => {
    const cleaned = u.replace(/[)\]>]+$/, "").replace(/[.,;:!?]+$/, "").trim();
    if (!cleaned || cleaned.length < 10) return false;
    if (seen.has(cleaned)) return false;
    seen.add(cleaned);
    return true;
  });
}

function extractUrlsFromAnnotations(content: ContentPart[]): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const part of content) {
    if (part.annotations) {
      for (const ann of part.annotations) {
        if (ann.type === "url_citation" && ann.url) {
          if (!seen.has(ann.url)) {
            seen.add(ann.url);
            urls.push(ann.url);
          }
        }
      }
    }
  }
  return urls;
}

async function callSearchEndpoint(
  queryText: string,
  apiKey: string
): Promise<OpenAIResponseData> {
  const prompt = SEARCH_PROMPT_TEMPLATE.replace("%s", queryText);

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      tools: [{ type: "web_search" }],
      input: prompt,
      temperature: 0.1,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `OpenAI Responses API error: ${res.status}${body ? ` — ${body.slice(0, 300)}` : ""}`
    );
  }

  return res.json();
}

function extractUrlsFromResponse(data: OpenAIResponseData): string[] {
  const messageOutput = data.output?.find(
    (o) => o.type === "message" && o.role === "assistant"
  );
  if (!messageOutput?.content || messageOutput.content.length === 0) {
    return [];
  }

  const annUrls = extractUrlsFromAnnotations(messageOutput.content);

  const text = messageOutput.content
    .filter((c) => c.type === "output_text")
    .map((c) => c.text || "")
    .join("\n");

  const textUrls = extractUrlsFromText(text);

  const merged = [...annUrls];
  const seen = new Set(annUrls.map((u) => u.toLowerCase()));
  for (const u of textUrls) {
    if (!seen.has(u.toLowerCase())) {
      merged.push(u);
    }
  }

  return merged;
}

export async function sourceCandidatePool(
  queryText: string,
  apiKey: string
): Promise<CandidatePoolItem[]> {
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for candidate pool sourcing");
  }

  const data = await callSearchEndpoint(queryText, apiKey);
  const rawUrls = extractUrlsFromResponse(data);

  const seen = new Set<string>();
  const items: CandidatePoolItem[] = [];

  for (const url of rawUrls) {
    const pageUrl = normalizeUrl(url);
    if (!pageUrl) continue;

    if (seen.has(pageUrl)) continue;
    seen.add(pageUrl);

    const companyDomain = normalizeDomain(pageUrl);
    if (!companyDomain) continue;

    items.push({ company_domain: companyDomain, page_url: pageUrl });
  }

  return items;
}

export async function sourceCandidatePools(
  queries: Array<{ text: string }>,
  apiKey: string
): Promise<CandidatePoolItem[]> {
  const results = await Promise.all(
    queries.map((q) => sourceCandidatePool(q.text, apiKey))
  );

  const seen = new Set<string>();
  const merged: CandidatePoolItem[] = [];
  for (const batch of results) {
    for (const item of batch) {
      if (seen.has(item.page_url)) continue;
      seen.add(item.page_url);
      merged.push(item);
    }
  }

  return merged;
}

export { CANDIDATE_POOL_VERSION };
