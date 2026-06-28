import { normalizeDomain } from "../../convex/lib/domain";

export interface UnderstandingResult {
  category: string;
  icp: string;
  positioning: string;
  what_you_are: string;
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenAIChoice {
  message: OpenAIMessage;
}

interface OpenAIResponse {
  choices: OpenAIChoice[];
}

const SYSTEM_PROMPT = `You analyze B2B SaaS company websites and produce a short structured understanding. Return ONLY valid JSON with these fields:
- "category": the product category (e.g. "GTM analytics", "CRM", "data pipeline")
- "icp": the ideal customer profile in 5-10 words (e.g. "PLG SaaS growth teams")
- "positioning": the competitive positioning in 5-10 words
- "what_you_are": a 4-line plain-English description of what the company does`;

function extractTextFromHtml(html: string): string {
  const stripped = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.slice(0, 5000);
}

export async function buildCompanyUnderstanding(
  domain: string,
  apiKey: string
): Promise<UnderstandingResult> {
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for company understanding");
  }

  const normDomain = normalizeDomain(domain);
  if (!normDomain) {
    throw new Error(`Invalid domain: ${domain}`);
  }

  const url = `https://${normDomain}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; GTM-Radar/1.0; +https://gtmradar.com)",
      Accept: "text/html",
    },
    redirect: "follow",
  });

  if (!res.ok) {
    throw new Error(
      `Failed to fetch ${url}: ${res.status} ${res.statusText}`
    );
  }

  const html = await res.text();
  const text = extractTextFromHtml(html);

  if (text.length < 50) {
    throw new Error(
      `Insufficient text content extracted from ${url} (${text.length} chars)`
    );
  }

  const openaiRes = await fetch(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Analyze this company's website content and produce the understanding JSON:\n\n${text}`,
          },
        ],
        temperature: 0.1,
        max_tokens: 500,
      }),
    }
  );

  if (!openaiRes.ok) {
    const body = await openaiRes.text().catch(() => "");
    throw new Error(
      `OpenAI API error: ${openaiRes.status}${body ? ` — ${body.slice(0, 300)}` : ""}`
    );
  }

  const data: OpenAIResponse = await openaiRes.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI returned empty response");
  }

  const cleaned = content
    .replace(/```json\s*/gi, "")
    .replace(/```\s*$/gm, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned) as Partial<UnderstandingResult>;
    return {
      category: parsed.category ?? "unknown",
      icp: parsed.icp ?? "unknown",
      positioning: parsed.positioning ?? "unknown",
      what_you_are: parsed.what_you_are ?? "unknown",
    };
  } catch {
    throw new Error(
      `Failed to parse OpenAI response as JSON: ${content.slice(0, 300)}`
    );
  }
}
