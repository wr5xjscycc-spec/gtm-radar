# GTM Radar — "GO LIVE" Claude Code Workflow
### Make the app actually run the loop, end-to-end, reproducible on any machine

> **This document IS the workflow.** Commit it to the repo as `docs/GO-LIVE-WORKFLOW.md` and push.
> A fresh Claude Code session on any machine can then execute it phase-by-phase. No opencode / no
> external terminals — it runs with Claude Code's own subagents.

---

## 0. Context & outcome

**Today** the app *simulates* the product with seeded data: onboarding triggers nothing, the board
numbers are planted by `scripts/seed-thin-slice.ts`, and analysis is a stub (`analysis/src/dummy.py`).

**Goal:** make it *actually do it* — onboard a company → **live** OpenAI citation measurement → **real**
Bayesian diagnosis → run a randomized experiment → **real** difference-in-differences causal lift →
the claim-ladder gate unlocks on genuine data.

**The key realization (already audited): this is ~80% wiring, not new science.** The hard parts exist
and are tested; the service just doesn't call them:
- **Stats brain is real but unplugged:** `analysis/src/bayes.py:123` `fit_bayesian_logistic` (real PyMC
  regularized-horseshoe), `analysis/src/did.py:163` `estimate_lift` (real statsmodels DiD + clustered
  SEs + CI/p-value), `analysis/src/hypotheses.py:71` `select_top_hypotheses`. All tested; **PyMC +
  statsmodels + sklearn already installed.** `service.py:40` just calls `dummy_model_fit`.
- **Measurement engine is real:** `measurement/src/engines/openai.ts:114` `runOpenAIQuery` (pure `fetch`
  → runs inside a Convex action) + helpers `buildLabeledRows`/`deriveEngineResult`.
- **Scraper + parsers real:** `sourcing/src/orangeslice-client.ts:27` (live SDK, verified live),
  `sourcing/src/parsers.ts`, `sourcing/src/features.ts`.

**Missing = connective tissue:** Convex actions that call these, the onboarding trigger, the
FitRequest→ModelingTable adapter, a `/estimate-lift` endpoint, a `runLift` action, a Node edge runner
for the Orange Slice SDK (can't run in Convex V8), and a concrete ChatModel adapter.

**Run mode = LIVE-FIRST.** Default wires real vendors (OpenAI citations, Orange Slice scrape) and real
local stats. An **offline fallback** (mocked vendors + seeded measurements + *real local stats*) is
documented so the **real closed loop is still provable on a machine with no keys** — and CI/unit tests
are always key-free and deterministic (mocked).

**Definition of done:** on a fresh clone, `docs/SETUP` works; all tests green; a real workspace driven
through the whole loop ends in a Rung-2 causal claim the gate licenses; everything pushed to GitHub on
a feature branch with CI green.

---

## 1. Prerequisites (the executing machine)

- **Node 20.x** (CI pins 20; local dev used 24 — prefer 20 to match CI). **Python 3.12**. git.
- **Keys for the LIVE path** (offline fallback works without them):
  - `OPENAI_API_KEY` — required for live measurement (A) + the gpt-5-mini ChatModel (B).
  - `ORANGESLICE_API_KEY` *or* a one-time `npx orangeslice login` (stores `~/.config/orangeslice/config.json`) — for live scrape (B).
  - `FIBER_API_KEY` — *optional*; battlefield runs as a thin slice from typed competitor domains without it.
- **No Convex account needed** — use the anonymous **local** deployment (verified this session).

### Env-var table (where each is read; REQUIRED = live path)
| Var | Where read | Live? |
|---|---|---|
| `OPENAI_API_KEY` | Convex deploy env (action), root `.env` (scripts) — `convex/measure.ts`, `measurement/scripts/*` | REQUIRED (A,B) |
| `ANALYSIS_SERVICE_URL` | `convex/analysis.ts:45` (defaults `http://localhost:8000`) | set to `http://127.0.0.1:8077` |
| `CONVEX_URL` / `VITE_CONVEX_URL` | `scripts/*`, `platform/src/main.tsx:8` | auto from `.env.local` |
| `ORANGESLICE_API_KEY` | OS SDK (`~/.config/orangeslice/config.json` fallback) | REQUIRED for live scrape (B) |
| `FIBER_API_KEY` | sourcing battlefield | optional |
| `AUTH_ISSUER_DOMAIN`/`AUTH_APP_ID` | `convex/auth.config.ts` | deferred (prod-only) |

### Secrets handling (do once, NEVER commit)
The user has provided the OpenAI key and completed `orangeslice login` (`~/.config/orangeslice/config.json`).
Store secrets ONLY in gitignored locations — never in any committed/pushed file, never in this doc:
```bash
# root .env (gitignored — verified) for the Node scripts/edge runners
printf 'OPENAI_API_KEY=%s\n' "<key>" >> .env
# Convex server-side deploy env (read by the action; never reaches the client)
npx convex env set OPENAI_API_KEY "<key>"
npx convex env set ANALYSIS_SERVICE_URL http://127.0.0.1:8077
# Orange Slice: already logged in (config file). Optional override: export ORANGESLICE_API_KEY=...
```
`.env`, `.env.local`, and `~/.config/orangeslice/` are gitignored. **Rotate the OpenAI key** — it was
pasted in chat (transcript-exposed). On another machine, the runner re-supplies the key via `.env`;
it is never baked into the repo.

---

## 2. Reproducible bootstrap (Phase 0 runs this; also becomes `scripts/bootstrap.sh`)

> **Gotcha the repo docs get wrong:** `convex/_generated/` is **gitignored** and the README says the
> first `npx convex dev` needs a browser login. It does **not** if you use the anonymous local flow.

```bash
# 0. clone
git clone <repo-url> gtm-radar && cd gtm-radar

# 1. node deps (workspaces: platform, measurement, sourcing)
npm install

# 2. python deps (heavy: pymc/pytensor build — allow a few min)
python3 -m venv analysis/.venv
analysis/.venv/bin/pip install -r analysis/requirements.txt

# 3. provision an ANONYMOUS LOCAL Convex backend (NO account/login) + generate convex/_generated/
npx convex dev --once --configure new --dev-deployment local --project gtm-radar
#   → writes .env.local (CONVEX_URL=http://127.0.0.1:3210) and convex/_generated/*
#   keep a long-running backend alive in another terminal for live use:
#   npx convex dev --tail-logs disable    # (the --once above only pushes; the daemon keeps :3210 up)

# 4. secrets (LIVE path)
cp .env.example .env        # then edit: OPENAI_API_KEY=...   (root .env, gitignored)
echo "VITE_CONVEX_URL=http://127.0.0.1:3210" > platform/.env.local
npx convex env set OPENAI_API_KEY "$OPENAI_API_KEY"          # the action reads Convex deploy env
npx convex env set ANALYSIS_SERVICE_URL http://127.0.0.1:8077
# Orange Slice (live scrape): npx orangeslice login   (or export ORANGESLICE_API_KEY)

# 5. baseline tests (key-free, must be green before any change)
npm test                                   # all TS workspaces (vitest, mocked)
analysis/.venv/bin/pytest analysis -q      # python (synthetic data)

# 6. analysis service (port 8077 — :8000 may be taken)
( cd analysis && .venv/bin/uvicorn src.service:app --host 127.0.0.1 --port 8077 ) &

# 7. seed + run the board
CONVEX_URL=http://127.0.0.1:3210 npx tsx scripts/seed-thin-slice.ts
npm run dev -w platform                    # http://localhost:5173
```

---

## 3. The workflow (Claude Code, parallel subagents)

Execution model: **3 lanes run as parallel Claude Code subagents** (Task/Agent, `general-purpose`),
each with a **writer subagent then a separate reviewer/tester subagent** (never the same context writes
and verifies). Lanes are contract-isolated (the frozen 9-record contract in `docs/CONTRACT.md` +
fixtures in `tests/integration/fixtures/`), so they parallelize cleanly. Then **serial** integration →
live verify → push. The orchestrating Claude holds the contract and is the writer≠reviewer backstop on
the load-bearing seams (the Convex actions).

> **Branch discipline:** all work on one feature branch `feat/go-live-loop` off `main`. Because lanes
> edit **disjoint files**, a single working tree is fine for Claude subagents (unlike opencode, the
> orchestrator serializes the actual edits it applies from each lane's diff). Keep edits within the
> file lists below.

### Phase 0 — Bootstrap & green baseline
Run §2 steps 0–5. **Gate:** `npm test` + `pytest` both green on a clean `main` checkout before touching
code. Create branch `feat/go-live-loop`.

### Phase 1 — Three lanes in parallel (writer → reviewer each)
Dispatch Cards A, B, C (below) as parallel `general-purpose` subagents. Each: implement against the
contract/fixtures, add tests, keep its lane's suite green, report a diff + test results. Reviewer
subagent re-checks each against the card's done-criteria + load-bearing invariants (claim-ladder gate,
no contract bypass, no secrets client-side).

### Phase 2 — Integration (serial, orchestrator)
1. Apply/assemble the three lane diffs onto `feat/go-live-loop`.
2. Regenerate Convex types if needed: `npx convex dev --once`. Run `npx tsc -p convex/tsconfig.json --noEmit`.
3. Full suite: `npm test` + `pytest` green.
4. **Build the orchestrator** (`convex/orchestrate.ts` or extend `measure.ts`): an action/scheduler
   chain so onboarding fires `buildBattlefield` (B) → enrich pages (B edge runner) → `measureWorkspace`
   (A) → `runFit` (C, real) — each idempotent, via `ctx.scheduler`.

### Phase 3 — Verification (two gates)
- **Gate 1 — OFFLINE real-loop (no keys, the reproducibility proof):** new `scripts/verify-loop.ts`
  drives the *real stats* loop end-to-end with **mocked vendors**: seed measurements + page features →
  `runFit` (real Bayesian) returns non-all-noise hypotheses → create experiment → seed post-window
  measurements → `runLift` (real DiD) → assert the causal block unlocks (rung 2). Runs on the local
  backend + the uvicorn service. **Zero keys, zero cost** — this is what proves "it really does it" on
  any machine. Extend the existing `scripts/verify-backend.ts` (21/21) pattern.
- **Gate 2 — LIVE smoke (keys, gated):** with keys set, `npx convex run measure:measureWorkspace
  '{"workspaceId":"<id>"}'` produces a **real** gut-punch; one live Orange Slice scrape produces a real
  page; confirm `runFit` over real rows returns real hypotheses. Watch the board fill at :5173.

### Phase 4 — Reproducibility hardening + docs
- Add `scripts/bootstrap.sh` (the §2 sequence) + `scripts/run-demo.sh` (start service + seed + frontend).
- Update `README.md` + `convex/README.md` to the **anonymous-local** flow (correct the "browser login"
  claim) and the new live-loop run path. Update `.env.example` comments (mark which are live-required).
- **Fresh-clone smoke (the real reproducibility test):** in a temp dir, `git clone` the pushed branch,
  run `scripts/bootstrap.sh`, and confirm `npm test` + `pytest` + `scripts/verify-loop.ts` all pass on
  the clean checkout — this catches gitignored-file gaps (e.g. `convex/_generated` regen).
- Commit this workflow as `docs/GO-LIVE-WORKFLOW.md`.

### Phase 5 — Push to GitHub
- Commit per lane with clear messages (Co-Authored-By trailer per `CONTRIBUTING.md`).
- Push `feat/go-live-loop`; open a PR; **ensure CI green** (`.github/workflows/ci.yml`: Node 20 TS tests
  + Python 3.12 pytest). CI is key-free (mocked) so it must pass without secrets.
- Report the PR URL + a one-paragraph "what's now real vs still stub/deferred."

---

## 4. Lane cards (the implementation spec)

### CARD A — Live Measurement + Orchestration  *(owns: `convex/measure.ts` NEW, `convex/customers.ts`, `convex/experiments.ts`, `platform/tests/measure.test.ts` NEW, `platform/src/App.tsx` 1-line)*
1. **`measureWorkspace({workspaceId, nQueries?})` action** in NEW `convex/measure.ts` (public `action`,
   default V8 — no `"use node"`). Reuse `runOpenAIQuery` (`measurement/src/engines/openai.ts:114`) +
   `buildLabeledRows` (`measurement/src/pipeline.ts:29`). Steps: read workspace via
   `ctx.runQuery(api.customers.getWorkspace)` → pure `buildSeedQueries(vertical,n)` (templated buyer
   questions, `seed_source:"keyword"`, default 6 / **cap 8**) → `insertQuery` each →
   **parallel** `Promise.allSettled` of `runOpenAIQuery` with a `fetch` wrapper using
   `AbortSignal.timeout(45000)` (a hang would otherwise burn the action) → candidate pool =
   `[own_domain, ...competitor_domains]` as `CandidatePage` → `buildLabeledRows` → `insertMeasurement`
   per row (`window_tag:"baseline"`, pass the real `queryId`). Actions can't touch `ctx.db` — go through
   `ctx.runMutation`/`runQuery`. Factor `buildSeedQueries` + pool-assembly as **pure exported fns**
   (testable). One failed query must not blank the board (allSettled isolates).
2. **Trigger:** `convex/customers.ts:15` `createWorkspace` gains `measure_on_create: v.optional(v.boolean())`
   **default false** (protects seed script + tests); when true →
   `ctx.scheduler.runAfter(0, api.measure.measureWorkspace, {workspaceId})` (add `import { api }`).
   Frontend `onCreate` (`platform/src/App.tsx`) passes `measure_on_create:true`.
3. **Re-measure loop:** `remeasure({experimentId})` action — same sweep with `window_tag:"post"` for the
   experiment's pages (feeds C's DiD). Wire `convex/experiments.ts:92` `monthlyBaseline` (no-op stub) to
   schedule real sweeps.
4. **Skeleton fix:** `platform/src/App.tsx:~523` → `if (!gut || Object.keys(gut.perEngine).length === 0)`
   so the panel shows "measuring…" during the ~30–60s sweep (not an empty list).
- **Tests:** `platform/tests/measure.test.ts` via convex-test (harness header from
  `platform/tests/onboarding.test.ts`): `vi.stubGlobal("fetch", …)` returning
  `measurement/tests/fixtures/openai-responses-web_search.json`; competitor includes a cited domain,
  own_domain not cited; `t.action(api.measure.measureWorkspace,{workspaceId,nQueries:2})`; assert
  `board.gutPunch` shows `you.cited===0`, `topCompetitor.cited>0`. Unit-test `buildSeedQueries` + pool.
- **Risk/fallback:** if the convex bundler can't resolve `../measurement/src/...`, inline-copy
  `runOpenAIQuery` + the ~15-line derive/build glue + `DEFAULT_MODEL="gpt-5-mini"` into `measure.ts`.
- **Done:** onboard → real gut-punch; convex-test green; all platform tests green.

### CARD B — Live Sourcing & Enrichment  *(owns: `convex/sourcing.ts` NEW, `sourcing/src/chat-openai.ts` NEW, `scripts/enrich-pages.ts`, sourcing tests)*
1. **`buildBattlefield({workspaceId})` action** (NEW `convex/sourcing.ts`): reuse `buildCompanyLayer`
   (`sourcing/src/battlefield.ts:169`) with an **empty Fiber stub** (thin slice — companies from
   `own_domain` + `competitor_domains`); write via `api.records.upsertCompany` (a CompanyWriter adapter
   over `ctx.runMutation`). (Real Fiber later: `createFiberClient` wrapping `sourcing/src/fiber.ts:31`.)
2. **ChatModel adapter** (NEW `sourcing/src/chat-openai.ts`): concrete `ChatModel`
   (port in `sourcing/src/understanding.ts`) backed by OpenAI **gpt-5-mini** via pure `fetch`; powers
   subjective features (`sourcing/src/features.ts:65`) + the "what you are" understanding card. Injectable.
3. **Live scrape edge runner:** the Orange Slice SDK **can't run in a Convex V8 action** → keep scraping
   in `scripts/enrich-pages.ts` (real client already wired). Fix the `workspaceId` placeholder (~line 41):
   accept a real `workspaceId` argv and pass to `api.records.upsertPage`. Confirm
   `enrichPages` (`sourcing/src/content.ts:146`) → `upsertPage` end-to-end against the mock client.
- **Tests:** mock Fiber + OrangeSliceClient + ChatModel; assert the battlefield action writes
  customer+competitor companies and the chat adapter parses a fake OpenAI response into the feature JSON.
  `npm test -w sourcing` green. Document (don't run) the live-scrape smoke (`enrich:smoke <domain>`).
- **Caveat (don't "fix"):** `scrape.website` returns **markdown** → `schema_markup`/`heading_structure`
  features are sparse vs HTML. Documented. (Upgrade path: `services.browser.execute`.)
- **Done:** real `companies` + real scraped `pages`; sourcing tests green; battlefield/enrichment panels render live.

### CARD C — Real Statistics (plug in the already-written brain)  *(owns: `analysis/src/service.py`, NEW `analysis/src/fit_real.py` if useful, `convex/analysis.ts` add `runLift`, analysis tests)*
1. **Real `model_fit`:** replace `dummy_model_fit` (`service.py:40`) with a real handler — bridge
   `FitRequest.rows` → `ModelingTable` (`weight = ci_weight(ci_width)` from `analysis/src/labeling.py`;
   assembly per `analysis/src/rows.py:118`) → `fit_bayesian_logistic` (`analysis/src/bayes.py:123`,
   modest `draws=300, tune=300, chains=2` for service latency) → `select_top_hypotheses`
   (`analysis/src/hypotheses.py:71`) → real `ModelFit`, `prior_version="phase4-reghs-v0"`. No new deps.
2. **Real `lift_result`:** add `POST /estimate-lift` to `service.py` (async via the existing JobStore,
   mirror `/fit` + `/fit/{job_id}`): accepts `Experiment` + `measurements` (baseline+post) → `estimate_lift`
   (`analysis/src/did.py:163`) → `LiftResult`.
3. **`runLift` Convex action** in `convex/analysis.ts` mirroring `runFit` (`:25`): POST
   `${ANALYSIS_SERVICE_URL}/estimate-lift` → poll → write via `api.records.insertLiftResult`. Reuse the
   existing SSRF guard (validate `job_id` `^[A-Za-z0-9_-]+$`, `encodeURIComponent`). Don't break `runFit`.
   Optionally `record_intervention` (`analysis/src/moat.py:32`) → `intervention`.
- **Tests:** `analysis/.venv/bin/pytest analysis -q` green (bayes/did already tested). ADD a service-level
  test: `/fit` on separable fixture data (`analysis/tests/fixtures/fit_request.json`) returns a `ModelFit`
  that is **not all-noise** (≥1 coefficient `noise_flag=False`) — proving the real path is wired, distinct
  from dummy. Be honest: if the fixture is too thin for a signal, assert the real path runs (real CIs,
  real prior_version) instead of forcing one.
- **Done:** `runFit` writes real hypotheses; a completed experiment with both windows yields a real DiD
  `lift_result` that unlocks the causal block; analysis pytest green.

---

## 5. Testing strategy (adequate coverage, layered)
- **Unit (CI, key-free, mocked):** every lane's vitest/pytest suite stays green; new tests added per
  card (A measure.test, B chat+battlefield, C service-fit non-noise). This is what `.github/workflows/ci.yml`
  runs (Node 20 + Python 3.12) — **must pass without secrets**.
- **Integration OFFLINE (no keys):** `scripts/verify-loop.ts` — the full **real-stats** closed loop on the
  local backend + uvicorn, vendors mocked/seeded. The reproducibility centerpiece.
- **Integration LIVE (keys, manual):** the §3 Gate-2 smokes (real measurement, real scrape, real fit).
- **Backend contract:** existing `scripts/verify-backend.ts` (21/21) re-run after the Convex changes.

## 6. Reproducibility checklist (the "someone else's computer" bar)
- [ ] Fresh `git clone` of `feat/go-live-loop` + `scripts/bootstrap.sh` → working stack in ~10–15 min.
- [ ] `convex/_generated` regenerated by the anonymous-local `convex dev --once` (no account/login).
- [ ] `npm test` + `pytest` green on the clean checkout.
- [ ] `scripts/verify-loop.ts` proves the **real loop** end-to-end with **zero keys**.
- [ ] With keys: live gut-punch + live scrape + real fit verified.
- [ ] CI green on the PR.

## 7. Risks / decisions
- **Convex cross-package bundling** (`convex/` importing `../measurement/src/...`): verify on
  `convex dev --once`; inline-copy fallback (Card A).
- **Orange Slice SDK ≠ Convex V8** → scraping stays a Node edge runner (Card B).
- **`convex/_generated` gitignored** → bootstrap must regenerate; CI doesn't need it (pure unit tests).
- **Node 24 local vs 20 CI** → develop/verify on Node 20.
- **Cost/latency** (live): gpt-5-mini ~31s/query — always parallelize; cap queries at 8.
- **Auth off by design** (`lib/auth.ts REQUIRE_AUTH=false`) — fine for demo; the one true production gate.
- **PyMC install** is heavy (pytensor build) — allow time on a fresh machine.

## 8. Out of scope (explicitly)
Real Fiber battlefield (thin-slice competitors instead), Perplexity/Gemini engines (openai-only v1),
multi-tenant auth, cloud Convex deploy, IDN/Punycode normalization (documented limitation).
