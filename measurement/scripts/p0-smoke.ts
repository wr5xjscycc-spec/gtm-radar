// P2 Phase 0 — live smoke run: "one engine, one citation".
//
// Fires ONE real buyer query at the OpenAI Responses API + web_search tool, parses the
// url_citation annotations, and emits a single `measurement` contract row for the top-cited
// source. This is the Phase-0 Definition of Done: a real citation with real source URLs.
//
// NOT part of `npm test` — it makes a paid, non-deterministic live call. Run it explicitly:
//   npm run smoke --prefix measurement      (reads OPENAI_API_KEY from gtm-radar/.env)
//
// CI never runs this; the adapter is covered by mocked/fixture unit tests.

import { fileURLToPath } from "node:url";
import { runOpenAIQuery } from "../src/engines/openai";
import { deriveEngineResult, buildMeasurementRow } from "../src/measurement";

// Load gtm-radar/.env (two levels up from this script) without any dependency.
try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // no .env file — fall back to whatever is already in the environment
}

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("OPENAI_API_KEY not set. Add it to gtm-radar/.env (gitignored) and retry.");
  process.exit(1);
}
const model = process.env.OPENAI_MODEL || "gpt-5-mini";

// A representative buyer query — the kind of question a B2B buyer asks an answer engine.
const query =
  "What are the best AI SDR (sales development) tools for B2B outbound sales in 2026?";
// Synthetic id: P0 has no real `query` record yet (P3 owns those). Stable so reruns are comparable.
const queryId = "p0-smoke-openai";

console.log(`[p0-smoke] engine=openai model=${model}`);
console.log(`[p0-smoke] query: ${query}\n`);

const result = await runOpenAIQuery({ query, apiKey, model });

if (result.citations.length === 0) {
  console.error(
    "[p0-smoke] No url_citation annotations returned. The request may have used a non-grounded " +
      "path or structured-output mode (which strips annotations). See the P2 brief Phase-0 gotchas.",
  );
  process.exit(2);
}

console.log(`[p0-smoke] captured ${result.citations.length} unique cited source(s):`);
for (const c of result.citations) {
  console.log(`  #${c.rank}  ${c.domain.padEnd(28)}  ${c.url}`);
}

// For this P0 demo, "the page we measure" is the #1 cited source — a real citation at position 1.
const topCitation = result.citations[0]!;
const engineResult = deriveEngineResult(result.citations, topCitation.url, result.answer_text);

const row = buildMeasurementRow({
  queryId,
  pageUrl: topCitation.url,
  engine: "openai",
  modelVersion: result.model_version,
  runIdx: 0,
  engineResult,
  ts: Date.now(),
});

console.log("\n[p0-smoke] measurement row (docs/CONTRACT.md §5 shape):");
console.log(JSON.stringify(row, null, 2));
console.log(
  `\n[p0-smoke] DoD ✓ — real citation captured: page "${row.page_url}" ` +
    `cited=${row.cited} position=${row.position} via ${row.engine}@${row.model_version}.`,
);
