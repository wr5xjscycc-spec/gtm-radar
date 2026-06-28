import { computeCitationResult, type EngineAdapter, type EngineResult } from "./engine";

export interface GeminiGroundingChunk {
  web?: { uri: string; title?: string };
  retrievedContext?: { uri: string; title?: string };
}

export interface GeminiGroundingMetadata {
  groundingChunks?: GeminiGroundingChunk[];
  groundingSupports?: Array<Record<string, unknown>>;
  webSearchQueries?: string[];
}

export interface GeminiCandidate {
  index: number;
  content: {
    role: string;
    parts: Array<{ text: string }>;
  };
  groundingMetadata?: GeminiGroundingMetadata;
}

export interface GeminiResponse {
  candidates: GeminiCandidate[];
  usageMetadata?: Record<string, number>;
  modelVersion?: string;
}

export function parseGeminiResponse(
  data: GeminiResponse,
  targetDomain: string,
): EngineResult {
  const sourceUrls: string[] = [];
  let modelVersion = "";

  for (const candidate of data.candidates ?? []) {
    if (!modelVersion) {
      modelVersion = data.modelVersion ?? "gemini-2.0-flash";
    }

    const meta = candidate.groundingMetadata;
    if (!meta?.groundingChunks) continue;

    for (const chunk of meta.groundingChunks) {
      const uri = chunk.web?.uri ?? chunk.retrievedContext?.uri;
      if (uri) sourceUrls.push(uri);
    }
  }

  return computeCitationResult("gemini", sourceUrls, targetDomain, modelVersion);
}

export function createGeminiAdapter(): EngineAdapter {
  return {
    async measure(queryText, options): Promise<EngineResult> {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("GEMINI_API_KEY environment variable is not set");
      }

      const url =
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent" +
        `?key=${apiKey}`;

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: queryText }] }],
          tools: [{ googleSearch: {} }],
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Gemini API error: ${response.status} ${response.statusText} — ${body}`,
        );
      }

      const data: GeminiResponse = await response.json();
      return parseGeminiResponse(data, options.targetDomain);
    },
  };
}
