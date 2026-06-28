/**
 * Records a real OpenAI Responses API + web_search response to a fixture file.
 *
 * Usage: OPENAI_API_KEY="sk-..." npx tsx scripts/record-fixture.ts
 *
 * Requires tsx (npx tsx) for ESM TypeScript execution. The key must be set in
 * the environment or loaded from the repo's .env.
 */

import { writeFileSync } from "fs";
import { resolve } from "path";

const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) {
  console.error(
    "ERROR: OPENAI_API_KEY environment variable is not set.\n" +
      "Set it directly or source the repo .env file.",
  );
  process.exit(1);
}

const QUERY = "best crm for startups 2026";
const OUTPUT_PATH = resolve(
  __dirname,
  "..",
  "tests",
  "fixtures",
  "openai-citation.json",
);

async function record(): Promise<void> {
  console.log(`Querying OpenAI Responses API: "${QUERY}"`);
  console.log(`Output: ${OUTPUT_PATH}`);

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      input: QUERY,
      tools: [{ type: "web_search" }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error(`API error ${response.status}: ${body}`);
    process.exit(1);
  }

  const data: unknown = await response.json();
  writeFileSync(OUTPUT_PATH, JSON.stringify(data, null, 2) + "\n");

  // Quick validation: count url_citation annotations
  const raw = data as Record<string, unknown>;
  const output = raw["output"] as Array<Record<string, unknown>> | undefined;
  let count = 0;
  if (output) {
    for (const item of output) {
      const content = item["content"] as
        | Array<Record<string, unknown>>
        | undefined;
      if (!content) continue;
      for (const block of content) {
        const anns = block["annotations"] as
          | Array<Record<string, unknown>>
          | undefined;
        if (!anns) continue;
        for (const ann of anns) {
          if (ann["type"] === "url_citation") count++;
        }
      }
    }
  }

  console.log(
    `\nDone. Wrote ${JSON.stringify(data).length} bytes, ${count} url_citation annotations.`,
  );
  if (count === 0) {
    console.warn(
      "WARNING: Zero url_citation annotations. The response may not have cited any sources.",
    );
  }
}

record().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
