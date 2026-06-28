export interface OffpageSignals {
  thirdparty_mentions?: number;
  reddit_presence?: number;
  g2_presence?: number;
  wikipedia_presence?: number;
  review_site_presence?: number;
  brand_search_volume?: number;
  backlink_density?: number;
  entity_cooccurrence?: number;
}

export interface OffpageResult {
  offpage: OffpageSignals;
  coverage_flags: string[];
  source_versions: Record<string, string>;
}

const OFFPAGE_VERSION = "offpage-2026.06-v1";

interface OpenAIResponseOutput {
  type: string;
  role?: string;
  content?: Array<{ type: string; text?: string }>;
}

interface OpenAIResponseData {
  id?: string;
  output?: OpenAIResponseOutput[];
}

function buildSearchPrompt(
  companyName: string,
  domain: string
): string {
  return `You are a B2B market researcher. I need structured off-page intelligence about "${companyName}" (${domain}).

Search for each of the following and return ONLY valid JSON (no markdown, no code fences):

{
  "reddit_presence": <integer — rough count of meaningful Reddit mentions/posts about this company in the last 12 months. 0 if none found.>,
  "g2_presence": <integer — does this company have a G2 profile? 0 if none found, 1+ if profile found.>,
  "wikipedia_presence": <integer — does this company have a Wikipedia article? 0 if none found, 1+ if article found.>,
  "review_site_presence": <integer — count of major review sites this company appears on (G2, Capterra, Trustpilot, Gartner, etc). 0 if none.>,
  "thirdparty_mentions": <integer — rough estimate of how many third-party blogs/articles mention this company. 0 if none.>,
  "entity_cooccurrence": <integer — how many distinct types of entities (other companies, analysts, journalists, investors) are commonly associated with this company. 0 if unknown.>
}

Be honest — if you cannot find evidence for a field, set it to 0. Never invent numbers.`;
}

async function callOpenAIWebSearch(
  prompt: string,
  apiKey: string
): Promise<string> {
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

  const data: OpenAIResponseData = await res.json();
  const messageOutput = data.output?.find(
    (o) => o.type === "message" && o.role === "assistant"
  );
  if (!messageOutput?.content) {
    throw new Error("OpenAI Responses API returned no message content");
  }

  const text = messageOutput.content
    .filter((c) => c.type === "output_text")
    .map((c) => c.text)
    .join("\n");

  if (!text) throw new Error("OpenAI Responses API returned empty text");
  return text;
}

function parseOffpageJson(raw: string): OffpageSignals {
  const cleaned = raw
    .replace(/```json\s*/gi, "")
    .replace(/```\s*$/gm, "")
    .trim();

  const parsed = JSON.parse(cleaned) as Record<string, unknown>;

  return {
    reddit_presence:
      typeof parsed.reddit_presence === "number" ? parsed.reddit_presence : 0,
    g2_presence:
      typeof parsed.g2_presence === "number" ? parsed.g2_presence : 0,
    wikipedia_presence:
      typeof parsed.wikipedia_presence === "number"
        ? parsed.wikipedia_presence
        : 0,
    review_site_presence:
      typeof parsed.review_site_presence === "number"
        ? parsed.review_site_presence
        : 0,
    thirdparty_mentions:
      typeof parsed.thirdparty_mentions === "number"
        ? parsed.thirdparty_mentions
        : 0,
    entity_cooccurrence:
      typeof parsed.entity_cooccurrence === "number"
        ? parsed.entity_cooccurrence
        : 0,
  };
}

export async function gatherOffpageSignals(
  companyName: string,
  domain: string,
  apiKey: string
): Promise<OffpageResult> {
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is required for off-page signal gathering"
    );
  }

  const prompt = buildSearchPrompt(companyName, domain);
  const raw = await callOpenAIWebSearch(prompt, apiKey);
  const offpage = parseOffpageJson(raw);

  const coverage_flags: string[] = [];
  if (offpage.brand_search_volume === undefined) {
    coverage_flags.push(
      "brand_search_volume:null — SERP API key required"
    );
  }
  if (offpage.backlink_density === undefined) {
    coverage_flags.push(
      "backlink_density:null — SERP API key required"
    );
  }

  return {
    offpage,
    coverage_flags,
    source_versions: { offpage_gathering: OFFPAGE_VERSION },
  };
}
