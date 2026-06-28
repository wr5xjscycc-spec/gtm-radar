/* Deep live-integration verification against the running local Convex backend.
   Exercises real mutations/queries: contract round-trip, normalization at EVERY
   write boundary, idempotency, schema rejection paths, and the claim-ladder
   read-layer gate. Isolated to a fresh throwaway workspace. NOT in CI. */
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";

const c = new ConvexHttpClient(process.env.CONVEX_URL || "http://127.0.0.1:3210");
const now = Date.now();
let pass = 0, fail = 0;
const fails: string[] = [];

function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; fails.push(name); console.log(`  FAIL  ${name}${detail ? "  — " + detail : ""}`); }
}
async function expectReject(name: string, fn: () => Promise<unknown>) {
  try { await fn(); ok(name, false, "expected rejection, but write SUCCEEDED"); }
  catch (e: any) { ok(name, true, "rejected: " + String(e.message || e).slice(0, 70)); }
}
async function expectOk(name: string, fn: () => Promise<unknown>) {
  try { await fn(); ok(name, true); }
  catch (e: any) { ok(name, false, "threw: " + String(e.message || e).slice(0, 90)); }
}

async function main() {
  const tag = `VERIFY-${now}`;
  console.log(`\n# Live Convex verification (fresh workspace ${tag})\n`);

  // --- A. CONTRACT + NORMALIZATION AT WRITE BOUNDARY ---
  console.log("## A. Contract round-trip + normalization at the mutation boundary");
  const ws = await c.mutation(api.customers.createWorkspace, {
    name: tag, vertical: "verify-vertical",
    own_domain: "https://WWW.Verify.com/", // messy on purpose
    competitor_domains: ["https://Rival.IO/", "www.Verify.com"],
    query_pack_id: "pack_verify",
  });
  const wsRow = (await c.query(api.customers.listWorkspaces, {})).find((w: any) => w._id === ws);
  ok("createWorkspace normalizes own_domain", wsRow?.own_domain === "verify.com", `stored=${wsRow?.own_domain}`);

  await c.mutation(api.records.upsertCompany, { workspaceId: ws, domain: "HTTPS://WWW.Acme.IO/x", name: "Acme", role: "customer" });
  let companies = await c.query(api.board.battlefield, { workspaceId: ws });
  ok("upsertCompany normalizes domain to eTLD+1", companies.some((x: any) => x.domain === "acme.io"), `domains=${companies.map((x:any)=>x.domain)}`);

  await c.mutation(api.records.upsertPage, { workspaceId: ws, company_domain: "WWW.Acme.IO", url: "https://WWW.Acme.io/Pricing/?utm_source=x", role: "candidate", extractor_version: "v1", scraped_at: now });
  const pages = await c.query(api.board.pages, { workspaceId: ws });
  ok("upsertPage normalizes url (https, www, path-case, trailing slash, utm)", pages.some((p: any) => p.url === "https://acme.io/Pricing"), `urls=${pages.map((p:any)=>p.url)}`);
  ok("upsertPage normalizes company_domain FK", pages.some((p: any) => p.company_domain === "acme.io"));

  const q = await c.mutation(api.records.insertQuery, { workspaceId: ws, customer_id: ws, vertical: "verify-vertical", text: "best tool?", seed_source: "paa", target_engines: ["openai"] });
  await c.mutation(api.records.insertMeasurement, { workspaceId: ws, query_id: q, page_url: "https://WWW.Acme.io/Pricing/", engine: "openai", model_version: "m1", run_idx: 0, appeared: true, cited: true, position: 1, source_urls: ["HTTPS://Acme.io/x", "www.rival.io"], ts: now, window_tag: "baseline" });
  const meas = await c.query(api.board.measurements, { workspaceId: ws });
  ok("insertMeasurement normalizes page_url", meas.some((m: any) => m.page_url === "https://acme.io/Pricing"));
  ok("insertMeasurement normalizes source_urls to domains", meas.some((m: any) => JSON.stringify(m.source_urls) === JSON.stringify(["acme.io", "rival.io"])), `src=${JSON.stringify(meas[0]?.source_urls)}`);

  // --- B. IDEMPOTENCY ---
  console.log("\n## B. Idempotency (upsert keyed on normalized key)");
  await c.mutation(api.records.upsertCompany, { workspaceId: ws, domain: "acme.io", name: "Acme RENAMED", role: "customer" });
  companies = await c.query(api.board.battlefield, { workspaceId: ws });
  const acmeRows = companies.filter((x: any) => x.domain === "acme.io");
  ok("upsertCompany twice -> ONE row (no duplicate)", acmeRows.length === 1, `count=${acmeRows.length}`);
  ok("upsertCompany twice -> row UPDATED", acmeRows[0]?.name === "Acme RENAMED");
  await c.mutation(api.records.upsertPage, { workspaceId: ws, company_domain: "acme.io", url: "https://acme.io/Pricing", role: "competitor", extractor_version: "v2", scraped_at: now });
  const pages2 = await c.query(api.board.pages, { workspaceId: ws });
  ok("upsertPage twice (same normalized url) -> ONE row", pages2.filter((p: any) => p.url === "https://acme.io/Pricing").length === 1);

  // --- C. SCHEMA REJECTION PATHS (validates the B-fix at the real DB boundary) ---
  console.log("\n## C. Rejection paths — malformed writes MUST be rejected");
  await expectReject("reject coverage_flags as object (schema: array<string>)", () =>
    c.mutation(api.records.upsertCompany, { workspaceId: ws, domain: "bad1.com", role: "battlefield", coverage_flags: { firmographics_missing: true } as any }));
  await expectReject("reject firmographics.headcount_growth as string (schema: number)", () =>
    c.mutation(api.records.upsertCompany, { workspaceId: ws, domain: "bad2.com", role: "battlefield", firmographics: { headcount_growth: "fast" } as any }));
  await expectReject("reject page content_features.heading_structure as object (schema: number)", () =>
    c.mutation(api.records.upsertPage, { workspaceId: ws, company_domain: "acme.io", url: "https://acme.io/bad", role: "candidate", extractor_version: "v1", content_features: { heading_structure: { h1: 1 } } as any }));
  await expectReject("reject measurement.engine bad enum ('bing')", () =>
    c.mutation(api.records.insertMeasurement, { workspaceId: ws, query_id: q, page_url: "https://acme.io/x", engine: "bing" as any, model_version: "m", run_idx: 0, appeared: true, cited: false, position: null, source_urls: [], ts: now, window_tag: "baseline" }));
  await expectReject("reject measurement.position as string (schema: number|null)", () =>
    c.mutation(api.records.insertMeasurement, { workspaceId: ws, query_id: q, page_url: "https://acme.io/x", engine: "openai", model_version: "m", run_idx: 0, appeared: true, cited: false, position: "1" as any, source_urls: [], ts: now, window_tag: "baseline" }));
  await expectReject("reject query.seed_source bad enum ('guess')", () =>
    c.mutation(api.records.insertQuery, { workspaceId: ws, customer_id: ws, vertical: "v", text: "t", seed_source: "guess" as any, target_engines: ["openai"] }));
  await expectReject("reject empty/garbage domain that can't normalize", () =>
    c.mutation(api.records.upsertCompany, { workspaceId: ws, domain: "   ", role: "battlefield" }));

  // sanity: a WELL-FORMED write still succeeds (rejection isn't blanket)
  await expectOk("accept a well-formed company with valid firmographics/coverage_flags", () =>
    c.mutation(api.records.upsertCompany, { workspaceId: ws, domain: "good.com", role: "battlefield", firmographics: { headcount_growth: 12, hiring_velocity: 3 }, coverage_flags: ["offpage_missing"] }));

  // --- D. CLAIM-LADDER GATE AT THE READ/ASSEMBLY LAYER ---
  console.log("\n## D. Claim-ladder gate (read layer: board.diagnosis)");
  await c.mutation(api.records.insertModelFit, { workspaceId: ws, customer_id: ws, category: "verify-vertical", engine: "openai", coefficients: [{ feature: "schema_markup", posterior_median: 0.4, ci_low: 0.1, ci_high: 0.7, noise_flag: false }], prior_version: "p1", top_hypotheses: ["schema_markup"], n_companies: 3, n_rows: 10 });
  let diag = await c.query(api.board.diagnosis, { workspaceId: ws });
  ok("diagnosis with model_fit but NO lift_result -> hasLiftResult false (causal locked)", diag?.hasLiftResult === false, `hasLiftResult=${diag?.hasLiftResult}`);
  ok("diagnosis exposes model_fit hypotheses at rung < 2", (diag?.modelFits?.length ?? 0) > 0 && (diag?.liftResults?.length ?? 0) === 0);

  const exp = await c.mutation(api.records.upsertExperiment, { workspaceId: ws, customer_id: ws, pairs: [{ treatment_page: "https://acme.io/t", control_page: "https://acme.io/c" }], status: "running" });
  await c.mutation(api.records.insertLiftResult, { workspaceId: ws, experiment_id: exp, estimate: 0.3, ci_low: 0.1, ci_high: 0.5, p_value: 0.03, verdict: "worked", claim_rung: 2, computed_at: now });
  diag = await c.query(api.board.diagnosis, { workspaceId: ws });
  ok("diagnosis AFTER lift_result -> hasLiftResult true (causal unlocked)", diag?.hasLiftResult === true);

  // --- E. WORKSPACE SCOPING ---
  console.log("\n## E. Workspace scoping");
  const allWs = await c.query(api.customers.listWorkspaces, {});
  const otherWs = allWs.find((w: any) => w._id !== ws);
  if (otherWs) {
    const mine = await c.query(api.board.battlefield, { workspaceId: ws });
    const theirs = await c.query(api.board.battlefield, { workspaceId: otherWs._id });
    const leak = mine.some((m: any) => theirs.some((t: any) => t._id === m._id));
    ok("battlefield query is workspace-scoped (no cross-workspace leak)", !leak);
  } else { console.log("  (only one workspace; scoping cross-check skipped)"); }

  console.log(`\n# RESULT: ${pass} passed, ${fail} failed`);
  if (fail) { console.log("FAILURES: " + fails.join(" | ")); process.exit(1); }
}
main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
