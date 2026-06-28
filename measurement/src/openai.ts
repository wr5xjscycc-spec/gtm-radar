import { computeCitationResult, type EngineAdapter, type EngineResult } from "./engine";

export interface OpenAICitationAnnotation {
  type: "url_citation";
  url: string;
  title?: string;
  start_index?: number;
  end_index?: number;
}

export interface OpenAIOutputText {
  type: "output_text";
  text: string;
  annotations?: OpenAICitationAnnotation[];
}

export interface OpenAIMessageOutput {
  type: "message";
  role: string;
  content: OpenAIOutputText[];
}

export interface OpenAIResponsesResponse {
  id: string;
  model: string;
  output: OpenAIMessageOutput[];
  created?: number;
  usage?: Record<string, number>;
}

export function parseOpenAIResponse(
  data: OpenAIResponsesResponse,
  targetDomain: string,
): EngineResult {
  const sourceUrls: string[] = [];

  for (const output of data.output) {
    if (output.type !== "message") continue;
    for (const content of output.content) {
      if (content.type !== "output_text") continue;
      if (!content.annotations) continue;
      for (const ann of content.annotations) {
        if (ann.type !== "url_citation") continue;
        sourceUrls.push(ann.url);
      }
    }
  }

  return computeCitationResult("openai", sourceUrls, targetDomain, data.model);
}

export function createOpenAIAdapter(): EngineAdapter {
  return {
    async measure(queryText, options): Promise<EngineResult> {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error("OPENAI_API_KEY environment variable is not set");
      }

      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o",
          input: queryText,
          tools: [{ type: "web_search" }],
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `OpenAI API error: ${response.status} ${response.statusText} — ${body}`,
        );
      }

      const data: OpenAIResponsesResponse = await response.json();
      return parseOpenAIResponse(data, options.targetDomain);
    },
  };
}
