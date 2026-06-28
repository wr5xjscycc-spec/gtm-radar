import { computeCitationResult, type EngineAdapter, type EngineResult } from "./engine";

export interface PerplexityResponse {
  id: string;
  model: string;
  citations: string[];
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
  }>;
  usage?: Record<string, number>;
}

export function parsePerplexityResponse(
  data: PerplexityResponse,
  targetDomain: string,
): EngineResult {
  return computeCitationResult(
    "perplexity",
    data.citations ?? [],
    targetDomain,
    data.model,
  );
}

export function createPerplexityAdapter(): EngineAdapter {
  return {
    async measure(queryText, options): Promise<EngineResult> {
      const apiKey = process.env.PERPLEXITY_API_KEY;
      if (!apiKey) {
        throw new Error("PERPLEXITY_API_KEY environment variable is not set");
      }

      const response = await fetch("https://api.perplexity.ai/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "sonar",
          messages: [{ role: "user", content: queryText }],
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Perplexity API error: ${response.status} ${response.statusText} — ${body}`,
        );
      }

      const data: PerplexityResponse = await response.json();
      return parsePerplexityResponse(data, options.targetDomain);
    },
  };
}
