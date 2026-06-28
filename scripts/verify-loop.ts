/* OFFLINE real-loop proof — drives the REAL statistics end-to-end through Convex,
   with NO vendor API keys (the stats run locally in the Python service). Proves:
   real Bayesian diagnosis (model_fit) → causal LOCKED → real randomized DiD
   (lift_result) → causal UNLOCKED. Requires the local Convex backend (:3210) and
   the analysis service (ANALYSIS_SERVICE_URL) running. NOT in CI. */
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const c = new ConvexHttpClient(process.env.CONVEX_URL || "http://127.0.0.1:3210");
const now = Date.now();
let pass = 0, fail = 0;
const ok = (n: string, cond: boolean, d = "") => {
  if (cond) { pass++; console.log(`  PASS  ${n}${d ? "  — " + d : ""}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? "  — " + d : ""}`); }
};

async function main() {
  console.log("\n# OFFLINE real-loop proof (no vendor keys; real local stats)\n");
  const ws = await c.mutation(api.customers.createWorkspace, {
    name: `LOOP-${now}`, vertical: "verify-loop", own_domain: "acme.com",
    competitor_domains: ["rival.com"], query_pack_id: "p",
  });

  // --- 1) REAL Bayesian model_fit via runFit (Convex -> Python service) ---
  console.log("## 1. Diagnosis — real Bayesian fit through runFit");
  const fitReq = JSON.parse(
    readFileSync(fileURLToPath(new URL("../analysis/tests/fixtures/fit_request.json", import.meta.url)), "utf8"),
  );
  await c.action(api.analysis.runFit, {
    workspaceId: ws, customer_id: ws, category: "verify-loop", engine: "openai",
    rows: fitReq.rows, features: fitReq.features,
  });
  let diag = await c.query(api.board.diagnosis, { workspaceId: ws });
  const mf = diag?.modelFits?.[0];
  ok("runFit wrote a model_fit", (diag?.modelFits?.length ?? 0) === 1);
  ok("model_fit is REAL (prior_version phase4-reghs-v0, not the dummy stub)", mf?.prior_version === "phase4-reghs-v0", `prior=${mf?.prior_version}`);
  ok("causal is LOCKED before any experiment (claim-ladder gate)", diag?.hasLiftResult === false);

  // --- 2) Randomized experiment + REAL DiD lift via runLift ---
  console.log("\n## 2. Experiment — real difference-in-differences through runLift");
  const PAIRS = 6;
  const pairs = Array.from({ length: PAIRS }, (_, i) => ({
    treatment_page: `https://acme.com/t${i}`,
    control_page: `https://acme.com/c${i}`,
  }));
  const expId = await c.mutation(api.records.upsertExperiment, {
    workspaceId: ws, customer_id: ws, pairs,
    baseline_window: "2026-06", post_window: "2026-07", status: "running",
  });

  // Windowed measurements: treatment pages move 0 -> 1 post-publish; controls stay 0.
  // (The DiD treatment:post coefficient recovers the planted +1.0 lift -> "worked".)
  const measurements: any[] = [];
  for (const p of pairs) {
    for (let k = 0; k < 3; k++) {
      measurements.push({ engine: "openai", page_url: p.treatment_page, window_tag: "baseline", cited: false, ts: now });
      measurements.push({ engine: "openai", page_url: p.control_page, window_tag: "baseline", cited: false, ts: now });
      measurements.push({ engine: "openai", page_url: p.treatment_page, window_tag: "post", cited: true, ts: now });
      measurements.push({ engine: "openai", page_url: p.control_page, window_tag: "post", cited: false, ts: now });
    }
  }
  await c.action(api.analysis.runLift, {
    workspaceId: ws, experiment_id: expId,
    experiment: { id: String(expId), customer_id: String(ws), pairs, baseline_window: "2026-06", post_window: "2026-07", status: "running" },
    measurements, engine: "openai", computed_at: new Date(now).toISOString(),
  });

  diag = await c.query(api.board.diagnosis, { workspaceId: ws });
  const lr = diag?.liftResults?.[0];
  ok("runLift wrote a lift_result", (diag?.liftResults?.length ?? 0) >= 1);
  ok("lift_result is REAL DiD (estimate + CI + p_value + verdict)", lr != null && typeof lr.estimate === "number" && typeof lr.p_value === "number" && !!lr.verdict, lr ? `estimate=${(lr.estimate).toFixed(2)} CI[${lr.ci_low?.toFixed(2)},${lr.ci_high?.toFixed(2)}] p=${lr.p_value} verdict=${lr.verdict}` : "none");
  ok("planted lift recovered as worked", lr?.verdict === "worked");
  ok("claim-ladder UNLOCKED — causal now licensed (hasLiftResult true, rung 2)", diag?.hasLiftResult === true);

  console.log(`\n# RESULT: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
  console.log("REAL CLOSED LOOP verified end-to-end through Convex with zero vendor keys.");
}
main().catch((e) => { console.error("HARNESS ERROR:", e?.message || e); process.exit(2); });
