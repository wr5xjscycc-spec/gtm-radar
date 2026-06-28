// P2·3 live integration check — proves the one-key three-engine path end-to-end against REAL
// OpenAI responses (NOT fixtures). Runs measureAdaptive over one query with all three engine
// slots (openai/perplexity/gemini, all OpenAI-backed) and prints per-engine aggregates.
//
// Run:  OPENAI_API_KEY=... npx tsx scripts/p2-3-live.ts
// Cost: kInitial=2,kMax=3 ⇒ at most 3 engines × 3 calls × ~$0.02 ≈ $0.18.

import { measureAdaptive } from "../src/sampling/adaptive";
import { buildOpenAIBackedRegistry, spreadOpenAIKey } from "../src/engines/openai-backed";
import { realizedCostUSD, adaptiveSavingsUSD } from "../src/cost";
import type { QueryRecord, CandidatePage } from "../src/contract-records";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("OPENAI_API_KEY not set");
  process.exit(1);
}

const query: QueryRecord = {
  id: "q-live-1",
  customer_id: "cust-live",
  vertical: "b2b-sales-lead-enrichment",
  text: "What are the best B2B sales lead enrichment platforms in 2026? Cite your sources.",
  seed_source: "keyword",
  target_engines: ["openai", "perplexity", "gemini"],
};

// A small candidate pool: real players in the space + a stand-in "customer" page.
const candidatePool: CandidatePage[] = [
  { company_domain: "apollo.io", url: "https://www.apollo.io/", role: "competitor" },
  { company_domain: "clay.com", url: "https://www.clay.com/", role: "competitor" },
  { company_domain: "zoominfo.com", url: "https://www.zoominfo.com/", role: "competitor" },
  { company_domain: "seraleads.com", url: "https://seraleads.com/", role: "customer" },
];

async function main() {
  const t0 = Date.now();
  const result = await measureAdaptive({
    query,
    candidatePool,
    registry: buildOpenAIBackedRegistry(),
    apiKeys: spreadOpenAIKey(apiKey!),
    ts: t0,
    kInitial: 2,
    kMax: 3,
  });

  const totalCalls = Object.values(result.perEngineK).reduce((a, b) => a + (b ?? 0), 0);

  console.log("\n=== perEngineK ===", result.perEngineK);
  console.log("=== failures ===", result.failures);
  console.log("=== total engine calls ===", totalCalls);

  console.log("\n=== aggregates (per query × page × engine) ===");
  for (const a of result.aggregates) {
    console.log(
      `${a.engine.padEnd(11)} ${a.page_url.padEnd(28)} ` +
        `k=${a.k} cited=${a.cited_count} P=${a.p_cited.toFixed(2)} ` +
        `CI=[${a.ci_low.toFixed(2)},${a.ci_high.toFixed(2)}] ` +
        `posW=${a.position_weight.toFixed(2)} model=${a.model_version}`,
    );
  }

  // Sanity assertions for the wiring (fail loud if the chain is broken).
  const engines = new Set(result.aggregates.map((a) => a.engine));
  const modelVersions = new Set(result.aggregates.map((a) => a.model_version));
  console.log("\n=== distinct engines in aggregates ===", [...engines]);
  console.log("=== distinct model_versions (should be the 3 real gpt-5* snapshots) ===", [
    ...modelVersions,
  ]);

  console.log(
    "\n=== cost ===",
    `realized ≈ $${realizedCostUSD(totalCalls).toFixed(2)} |`,
    adaptiveSavingsUSD({
      numQueries: 1,
      numEngines: query.target_engines.length,
      kMax: 3,
      actualCalls: totalCalls,
    }),
  );

  if (engines.size !== 3) {
    console.error("\nFAIL: expected 3 engines in aggregates, got", engines.size);
    process.exit(1);
  }
  console.log("\nOK — three OpenAI-backed engine slots produced per-engine aggregates over real responses.");
}

main().catch((e) => {
  console.error("LIVE RUN ERROR:", e);
  process.exit(1);
});
