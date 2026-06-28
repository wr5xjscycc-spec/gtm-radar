/**
 * Phase-0 thin-slice E2E seed (owner: P1).
 *
 * Pushes the 9-record thin slice through the NORMALIZED mutation path into the
 * live Convex deployment, then reads it back via the board queries. This is the
 * Phase-0 integration milestone — "thin slice runs end-to-end on seed data" —
 * proven against the real backend, not a mock.
 *
 * It deliberately feeds messy inputs (`https://www.Acme.com/`) to prove the
 * domain helper normalizes AT THE MUTATION BOUNDARY (stored key must be `acme.com`).
 *
 * Run:  CONVEX_URL=$(grep ^CONVEX_URL .env.local | cut -d= -f2) npx tsx scripts/seed-thin-slice.ts
 */
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";

const url = process.env.CONVEX_URL;
if (!url) throw new Error("set CONVEX_URL (see .env.local)");
const c = new ConvexHttpClient(url);
const now = Date.now();

async function main() {
  // 1) Onboarding — messy own_domain on purpose; mutation must normalize it.
  const ws = await c.mutation(api.customers.createWorkspace, {
    name: "Acme Analytics",
    vertical: "gtm-analytics",
    own_domain: "https://www.Acme.com/",
    competitor_domains: ["competitor.com", "https://rival.io/", "www.Acme.com"],
    query_pack_id: "pack_gtm_analytics_v1",
  });

  // 2) Battlefield (P3 shape)
  for (const co of [
    { domain: "acme.com", name: "Acme Analytics", role: "customer" as const },
    { domain: "competitor.com", name: "Competitor Inc", role: "competitor" as const },
    { domain: "rival.io", name: "Rival.io", role: "battlefield" as const },
  ]) {
    await c.mutation(api.records.upsertCompany, { workspaceId: ws, ...co });
  }

  // 3) Pages (P3 shape)
  await c.mutation(api.records.upsertPage, {
    workspaceId: ws, company_domain: "acme.com", url: "https://acme.com/pricing",
    role: "candidate", extractor_version: "orangeslice-2026.06",
  });
  await c.mutation(api.records.upsertPage, {
    workspaceId: ws, company_domain: "competitor.com", url: "https://competitor.com/pricing",
    role: "competitor", extractor_version: "orangeslice-2026.06",
  });

  // 4) Query (P3 shape)
  const q = await c.mutation(api.records.insertQuery, {
    workspaceId: ws, customer_id: ws, vertical: "gtm-analytics",
    text: "best GTM analytics tool for PLG SaaS", seed_source: "paa",
    target_engines: ["openai"], // v1: OpenAI-only (others dormant until keyed)
  });

  // 5) Measurements (P2 shape) — the gut-punch: Acme 0/1, Competitor 1/1
  await c.mutation(api.records.insertMeasurement, {
    workspaceId: ws, query_id: q, page_url: "https://acme.com/pricing", engine: "openai",
    model_version: "responses-2026.06", run_idx: 0, appeared: false, cited: false,
    position: null, source_urls: ["https://competitor.com/pricing", "rival.io"],
    ts: now, window_tag: "baseline",
  });
  await c.mutation(api.records.insertMeasurement, {
    workspaceId: ws, query_id: q, page_url: "https://competitor.com/pricing", engine: "openai",
    model_version: "responses-2026.06", run_idx: 0, appeared: true, cited: true,
    position: 1, source_urls: ["competitor.com"], ts: now, window_tag: "baseline",
  });

  // 6) model_fit (P4 dummy) — hypothesis layer, never causal
  await c.mutation(api.records.insertModelFit, {
    workspaceId: ws, customer_id: ws, category: "GTM analytics", engine: "openai",
    coefficients: [
      { feature: "comparison_table", posterior_median: 0.82, ci_low: 0.21, ci_high: 1.44, noise_flag: false },
      { feature: "word_count", posterior_median: 0.05, ci_low: -0.31, ci_high: 0.4, noise_flag: true },
    ],
    prior_version: "r2d2-2026.06",
    top_hypotheses: ["comparison_table correlates with citation in this category; test it"],
    n_companies: 24, n_rows: 312,
  });

  // Read back through the board (reactive query path)
  const summary = await c.query(api.board.summary, { workspaceId: ws });
  const cite = await c.query(api.board.citationBoard, { workspaceId: ws });
  const battlefield = await c.query(api.board.battlefield, { workspaceId: ws });
  const gut = await c.query(api.board.gutPunch, { workspaceId: ws });
  const diag = await c.query(api.board.diagnosis, { workspaceId: ws });

  console.log("workspaceId:", ws);
  console.log("own_domain stored as:", summary.workspace.own_domain, "(input was https://www.Acme.com/)");
  console.log("competitor_domains:", JSON.stringify(summary.workspace.competitor_domains));
  console.log("counts:", JSON.stringify(summary.counts));
  console.log("battlefield domains:", JSON.stringify(battlefield.map((b: any) => `${b.domain}:${b.role}`)));
  console.log("openai citations:", JSON.stringify(cite.perEngine.openai));
  console.log("GUT-PUNCH (you):", JSON.stringify(gut.perEngine.openai.you));
  console.log("GUT-PUNCH (top competitor):", JSON.stringify(gut.perEngine.openai.topCompetitor));

  // Assertions — fail loudly if the thin slice doesn't hold
  console.log("DIAGNOSIS rung:", diag.rung, "(1=hypothesis, 2=causal) · hasLiftResult:", diag.hasLiftResult);
  const ok =
    summary.workspace.own_domain === "acme.com" &&
    !summary.workspace.competitor_domains.includes("acme.com") &&
    summary.counts.companies === 3 &&
    summary.counts.measurements === 2 &&
    cite.perEngine.openai.cited === 1 &&
    cite.perEngine.openai.total === 2 &&
    // claim-ladder: a model_fit exists but no lift_result -> causal stays LOCKED at rung 1
    diag.rung === 1 &&
    diag.hasLiftResult === false &&
    diag.liftResults.length === 0;
  if (!ok) throw new Error("THIN-SLICE ASSERTIONS FAILED — see output above");
  console.log("\n✅ DAY-1 E2E OK — gut-punch (1/2) + diagnosis at rung 1 (causal locked, no lift_result) from live backend");

  // ---- CLOSED LOOP: experiment -> publish-gate -> causal lift -> Rung 2 ----
  const exp = await c.mutation(api.records.upsertExperiment, {
    workspaceId: ws, customer_id: ws,
    pairs: [{ treatment_page: "https://acme.com/pricing", control_page: "https://acme.com/about" }],
    status: "designing",
  });
  await c.mutation(api.experiments.requestPublish, { experimentId: exp });
  await c.mutation(api.experiments.recordPublish, { experimentId: exp }); // publish event -> running
  await c.mutation(api.records.insertLiftResult, {
    workspaceId: ws, experiment_id: exp, estimate: 0.18, ci_low: 0.04, ci_high: 0.32,
    p_value: 0.012, verdict: "worked", claim_rung: 2, computed_at: now,
  });
  const diag2 = await c.query(api.board.diagnosis, { workspaceId: ws });
  const feed = await c.query(api.experiments.consoleFeed, { workspaceId: ws });
  const row = feed.find((e: any) => e._id === exp);
  console.log("AFTER EXPERIMENT — diagnosis rung:", diag2.rung, "· status:", row?.status, "· lift:", row?.lift?.verdict);
  const loopOk = diag2.rung === 2 && row?.status === "running" && row?.lift?.verdict === "worked";
  if (!loopOk) throw new Error("CLOSED-LOOP ASSERTIONS FAILED — see output above");
  console.log("✅ CLOSED LOOP OK — publish-gated experiment -> lift_result -> Rung-2 causal unlocked, live");
}

main().catch((e) => { console.error(e); process.exit(1); });
