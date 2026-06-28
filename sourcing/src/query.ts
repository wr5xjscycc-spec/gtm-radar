export interface QueryRecord {
  id: string;
  customer_id: string;
  vertical: string;
  text: string;
  seed_source: "paa" | "keyword" | "reddit" | "analytics" | "llm_expand";
  target_engines: string[];
}

const QUERY_VERSION = "query-2026.06-v1";

function generateId(customerId: string, vertical: string, idx: number): string {
  const slug = vertical.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 20);
  return `q-${customerId}-${slug}-${idx}`;
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

async function callChatCompletions(
  messages: OpenAIMessage[],
  apiKey: string,
  temperature = 0.1
): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages,
      temperature,
      max_tokens: 2000,
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
  return content;
}

interface OpenAIResponseOutput {
  type: string;
  role?: string;
  content?: Array<{ type: string; text?: string }>;
}

interface OpenAIResponseData {
  id?: string;
  output?: OpenAIResponseOutput[];
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

function parseQuestionList(raw: string): string[] {
  const cleaned = raw.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed.filter((q) => typeof q === "string" && q.length > 5);
    if (Array.isArray(parsed.questions)) return parsed.questions.filter((q: unknown) => typeof q === "string");
    if (Array.isArray(parsed.queries)) return parsed.queries.filter((q: unknown) => typeof q === "string");
  } catch {
    const lines = cleaned
      .split("\n")
      .map((l) => l.replace(/^[-*\d]+\.?\s*/, "").trim())
      .filter((l) => l.length > 5 && !l.startsWith("{") && !l.startsWith("["));
    if (lines.length >= 2) return lines;
  }
  return [];
}

const BUYER_QUESTIONS_PROMPT = `You are a B2B buyer intelligence analyst. Search the web for real questions that buyers ask when evaluating software in a specific category.

Return ONLY a JSON array of strings — the most common, real buyer questions. Each question must be a genuine question a buyer would type into a search engine or ask a sales rep.

Format: ["question 1", "question 2", ...]

Example for "CRM" vertical:
["best crm for small business", "salesforce vs hubspot pricing 2026", "how much does salesforce cost per user", "crm with email integration", "what is the easiest crm to use"]

Return 8-12 questions. Each should be 3-15 words.`;

export async function generateQuerySet(
  vertical: string,
  customerId: string,
  apiKey: string
): Promise<QueryRecord[]> {
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for query generation");
  }

  const groundPrompt = `${BUYER_QUESTIONS_PROMPT}\n\nVertical: "${vertical}"`;
  const rawOutput = await callOpenAIWebSearch(groundPrompt, apiKey);
  const groundQuestions = parseQuestionList(rawOutput);

  const records: QueryRecord[] = [];
  let idx = 0;

  for (const q of groundQuestions) {
    records.push({
      id: generateId(customerId, vertical, idx),
      customer_id: customerId,
      vertical,
      text: q,
      seed_source: "keyword",
      target_engines: ["openai"],
    });
    idx++;
  }

  if (groundQuestions.length >= 3) {
    const subset = groundQuestions.slice(0, Math.min(3, groundQuestions.length));
    const expandPrompt = `Given these real buyer questions about "${vertical}" software:

${subset.map((q, i) => `${i + 1}. "${q}"`).join("\n")}

Generate 5-8 ADDITIONAL related buyer questions that a software buyer might ask. These should be:
- Related but different from the seed questions
- Realistic search queries a B2B buyer would type
- Cover adjacent angles (pricing, features, comparisons, alternatives, integrations)

Return ONLY a JSON array of strings.`;

    const expandRaw = await callChatCompletions(
      [
        { role: "system", content: "You generate realistic B2B buyer questions. Return ONLY valid JSON arrays." },
        { role: "user", content: expandPrompt },
      ],
      apiKey
    );

    const expandQuestions = parseQuestionList(expandRaw);
    for (const q of expandQuestions) {
      records.push({
        id: generateId(customerId, vertical, idx),
        customer_id: customerId,
        vertical,
        text: q,
        seed_source: "llm_expand",
        target_engines: ["openai"],
      });
      idx++;
    }
  }

  return records;
}

export { QUERY_VERSION };
