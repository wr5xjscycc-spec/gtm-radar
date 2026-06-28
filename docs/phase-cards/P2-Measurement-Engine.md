# P2 — Measurement Engine · Detailed Build Brief

**You own what we measure.** The answer-engine layer: adapters for all 3 engines, K-repeats, adaptive sampling, position weighting, citation parsing/normalization, case-control labeling, version stamping, model-drift detection, cost/budget guards, and per-engine reliability. Your output — `measurement` rows with **P(cited) + CI** — is the descriptive-truth layer the entire product stands on. If your signal is noisy or mis-specified, every downstream claim is poisoned.

> Read `GTM-Radar-Architecture.md` (§4.2, §8, §11) and `GTM-Radar-redteam-and-patches.md` (Theme A, Theme B) before starting. The red-team's deepest measurement holes are *your* responsibility to neutralize.

---

## Shared context (true for all lanes)

**The contract = the Convex record set**, joined on **normalized domain** (P1 owns the helper — use it; never invent your own key format). The records you touch most:

- **query** — id, customer_id, vertical, text, seed_source, target_engines[]. *(You consume these.)*
- **page** — company_domain, url(normalized), role(candidate|customer|competitor)… *(candidate pages from P3 are your loser pool.)*
- **measurement** — id, query_id, page_url, **engine**(openai|perplexity|gemini), **model_version**, run_idx, appeared, cited, **position**, source_urls[], ts, window_tag(baseline|post|adhoc), experiment_id?. Aggregates → **P_cited, ci_low, ci_high, position_weight**. *(You write these.)*

**The non-negotiable measurement facts (from the red-team):**
1. **Plain chat-completions return NO citations.** You MUST use the **OpenAI Responses API with the `web_search` tool** (gives `url_citation` annotations). A base-model call measures training data, not the live answer engine — that invalidates the whole product. Same spirit for the others: use the *grounded* path.
2. **Answers are non-deterministic.** A single query run once is a coin flip. The outcome must be **P(cited) estimated over K repeats with a CI**, not a single binary. (This is why labels are a rate, not a draw.)
3. **Engines disagree (~11% citation overlap).** Keep everything **per-engine**; never merge into one number silently.
4. **A "loser" is not any uncited page** — it's a page that was *retrieved/considered* (or ranks in classic search) but not cited. Arbitrary uncited pages bias the model (selection bias). You implement this case-control labeling.
5. **Models drift silently.** Stamp every row with `engine + model_version + ts` so a mid-sweep change is detectable.
6. **API-only in v1.** No scraping engine UIs (ToS risk). AI Overviews is deferred (no API).

**Phase timeline:** 0 Foundations → 1 Onboarding/Battlefield → 2 Enrich/Query/Feature → 3 **Measurement (your heavy phase)** → 4 Diagnosis → 5 Experiment/Loop → 6 Ship.

---

## Testing standard (applies to every card)

No card is **Done** until its work ships with **passing automated tests in CI** (see `CONTRIBUTING.md` / `docs/TESTING.md`). Engines (OpenAI/Perplexity/Gemini) are **mocked in unit tests** and run via **recorded fixtures** in integration tests — **never live in CI** (cost + non-determinism). Tests land with the code.

| Phase | P2 required tests / setup |
|---|---|
| 0 | lane scaffold + **vitest** harness green in CI; OpenAI adapter test with **mocked HTTP** returning a fixture containing `url_citation` annotations (assert citations parsed) |
| 1 | adapter contract tests for all 3 engines against **recorded fixtures**; assert each engine's citation path is parsed into the common shape |
| 2 | dispatch-harness + citation-parser unit tests; **case-control labeling tests** (a "loser" can come ONLY from the candidate pool, never an arbitrary uncited page) |
| 3 | K-repeats → **P(cited)+CI math tests**; **adaptive-sampling stopping-rule tests** (Wilson CI extends only ambiguous pages); position-weighting tests; version-stamp tests; one **recorded-fixture integration sweep** |
| 4 | label-flip-rate measurement test (quantify non-determinism on a fixture) |
| 5 | window-tagging tests (baseline/post + experiment_id); identical-arm-protocol test (treatment & control measured the same) |
| 6 | budget-cap + **graceful-degradation** tests; **per-engine isolation** test (one engine down ⇒ cycle continues, partial coverage flagged); **model-drift detection** test; coverage ≥ target |

---

## Phase 0 — One engine, one citation

**Goal:** prove the measurement contract end-to-end with a single real citation.

**Why it matters:** de-risks the single most important and most-likely-to-be-wrong assumption (that we can get real citations programmatically). If this doesn't work, the product doesn't exist — find out in hour one.

**Depends on:** P1·0 (schema, domain helper, action pattern).

**Detailed tasks:**
1. Build the **OpenAI Responses API + `web_search`** adapter; issue one buyer query; read back the `url_citation` annotations (source URLs).
2. Normalize source URLs → domains via P1's helper.
3. Write one **measurement** row in the agreed shape `{query_id, page_url, engine:"openai", model_version, run_idx:0, appeared, cited, position, source_urls[], ts}`.

**Records:** reads one `query`; writes one `measurement`.
**Gotchas:** confirm you are NOT on chat-completions. Verify the annotations are actually populated — the red-team found annotations often come back empty unless the request is shaped correctly (and JSON-structured-output mode can strip them). Test the real response shape, don't assume.
**Tools:** OpenAI Responses API, Convex action.
**DoD:** a real citation with real source URLs is captured and visible on P1's board.
**Hand-off:** proves the contract; P1 can render measurement; P4 knows the row shape.

---

## Phase 1 — Engine accounts, limits & the measurement contract

**Goal:** remove integration risk before volume; freeze the row contract.

**Why it matters:** at 3 engines × K repeats × 300–500 queries you'll hit rate limits and cost surprises if you haven't mapped them. The `web_search` tool has a hidden multiplier (community-confirmed ~2–3× sub-searches per call) that affects both cost and latency.

**Depends on:** P2·0.

**Detailed tasks:**
1. Provision keys for **OpenAI, Perplexity (Sonar/Sonar Pro), Gemini (grounded)**; record each one's **rate limits** and **per-call cost** (OpenAI web_search $10/1k + 8k tokens, watch the sub-search multiplier; Perplexity $3/$15 per 1M + $6–14/1k requests; Gemini small free tier then ~$0.005–0.019/call).
2. Confirm the **citation path per engine**: OpenAI `url_citation`; Perplexity native citations; Gemini grounding metadata.
3. Freeze the normalized **measurement-row contract** + the common adapter interface every engine maps into (`{appeared, cited, position, sources[]}`).

**Records:** finalizes `measurement` shape; writes none yet.
**Gotchas:** budget the hidden web_search sub-search multiplier now, or Phase-6 cost guards will be calibrated wrong. Note where citations vanish (structured-output mode, missing "include citations" phrasing).
**Tools:** OpenAI, Perplexity, Gemini.
**DoD:** all three engines authenticated; rate/cost documented; row contract frozen and shared.
**Hand-off:** P4 codes its row-assembly against the frozen contract; P1 finalizes the board fields.

---

## Phase 2 — Dispatch harness, citation parser & labeling logic

**Goal:** the plumbing that turns queries into clean, correctly-labeled rows.

**Why it matters:** the labeling rule (case-control) is a statistical correctness requirement, not a detail — getting it wrong reintroduces the selection-bias hole the patches closed.

**Depends on:** P2·1; consumes P3's candidate pool (P3·3) and SERP ranking — develop against fixtures until those land.

**Detailed tasks:**
1. **Query→engine dispatch harness**: read `query` records, fan to the engine adapters per `target_engines`, collect normalized results.
2. **Citation parser**: source URLs → domains (P1 helper); map cited domains back to `company`/`page` records to mark who was cited.
3. **Case-control labeling logic**: `cited=true` → winner; **loser = a page in the candidate pool (retrieved/considered or classic-search-ranked for that query) that was not cited** — NOT an arbitrary uncited page. Build it against fixtures now.

**Records:** reads `query`, P3 candidate pool, `page`; writes labeled (pre-aggregation) `measurement` scaffolding.
**Gotchas:** do not let "loser" mean "any page we have that wasn't cited." If the candidate pool isn't ready, stub it but keep the interface exact so the real pool drops in.
**Tools:** Convex actions.
**DoD:** queries dispatch and produce normalized, case-control-labeled rows on fixtures.
**Hand-off:** the moment P3's pool + real queries exist, Phase 3 turns this into volume.

---

## Phase 3 — All 3 engines, probabilistic labels & adaptive sampling  *(heavy phase)*

**Goal:** the core measurement deliverable — P(cited)+CI across all engines, affordably.

**Why it matters:** this is the descriptive-truth layer and the demo's gut-punch source. Two red-team holes are closed *here*: non-determinism (via K-repeats→rate) and cost (via adaptive sampling).

**Depends on:** P2·2; P3·2 (real queries), P3·3 (candidate pool).

**Detailed tasks:**
1. Add **Perplexity Sonar** and **Gemini grounding** adapters, both normalized to the common `{appeared, cited, position, sources[]}` shape.
2. **K-repeats**: run each query multiple times per engine; aggregate to **P_cited with a confidence interval** (Wilson). Store run-level rows + the aggregate.
3. **Position weighting**: capture citation `position` and compute an ordinal `position_weight` (a #1 citation ≫ a #3 — clicks concentrate on the first source).
4. **Adaptive sampling**: start **K=3**; compute the Wilson CI on P_cited; **extend to K≈8 only** for pages whose interval is still wide / straddles the midpoint. This is the −40–50% cost lever — implement it as part of the core loop, not an afterthought.
5. **Version-stamp** every row (`engine`, `model_version`, `ts`).

**Records:** reads `query` (all engines), candidate pool; writes `measurement` rows + aggregates (P_cited, ci, position_weight, versions).
**Gotchas:** don't ship fixed-K — it both wastes budget and under-samples ambiguous pages. Keep per-engine separation through aggregation. Make sure K-repeats actually vary (don't accidentally cache identical responses).
**Tools:** OpenAI, Perplexity, Gemini, Convex actions.
**DoD:** per-(query, page, engine) **P_cited + CI + position** for all 3 engines, within budget; P1's gut-punch board goes live on real data.
**Hand-off:** P4 can construct winner/loser rows; P1's board shows the real "0 of 12."

---

## Phase 4 — Label quality for the model

**Goal:** guarantee the hypothesis generator gets clean, correctly-keyed inputs.

**Why it matters:** garbage labels → garbage coefficients. P4's honesty depends on your label quality; you also supply the *effective-N* signal (cluster = company) implicitly via correct keying.

**Depends on:** P2·3.

**Detailed tasks:**
1. Produce clean **per-engine aggregate tables** keyed on normalized domain/URL for P4 to join.
2. **QA label noise**: re-run a sample of queries; quantify how often a page flips winner/loser across runs; document residual noise for honest reporting (feeds the uncertainty story).
3. Confirm the case-control pool composition is sane per category (not dominated by one company's pages).

**Records:** reads `measurement`; writes/curates model-ready label tables.
**Gotchas:** report the measured flip-rate — don't bury it. If a category's loser pool is degenerate, flag it to P3.
**Tools:** Convex.
**DoD:** P4 assembles winner/loser rows directly from your outputs; flip-rate is documented.
**Hand-off:** P4·3/P4·4 can fit on trustworthy labels.

---

## Phase 5 — Experiment re-measurement

**Goal:** supply the experiment engine with baseline + post measurements, correctly windowed.

**Why it matters:** the DiD causal estimate is only valid if pre/post measurements are clean, version-stamped, and tagged to the right window and experiment. This is how the moat's causal data is actually generated.

**Depends on:** P4·5 (`experiment` records), P1·5 (scheduler/publish triggers).

**Detailed tasks:**
1. **Event-driven re-measurement**: on a publish event (treatment shipped) and on the scheduled post-window, run measurement for the experiment's pages.
2. **Window tagging**: tag rows `window_tag = baseline|post` and stamp `experiment_id` so P4's DiD can separate pre/post and treatment/control.
3. Keep **both arms measured identically** (treatment and control pages get the same measurement protocol — any asymmetry biases the DiD).

**Records:** reads `experiment`, publish events; writes `measurement` rows tagged `baseline/post` + `experiment_id`.
**Gotchas:** measure control and treatment with identical cadence/engines — asymmetric measurement is a confound. Version-stamp so a mid-experiment model update is visible (it's a known DiD threat).
**Tools:** OpenAI, Perplexity, Gemini, Convex actions.
**DoD:** an experiment's pre/post citation rates are measured, windowed, and tagged for DiD.
**Hand-off:** P4·5 computes lift from your tagged rows.

---

## Phase 6 — Cost guards, reliability & drift detection

**Goal:** keep cycles inside ~$100–120 and survive flaky engines.

**Why it matters:** unit economics were the #1 surviving risk in Round 3. Your guards are the difference between a viable product and one whose COGS eats the revenue. Reliability keeps the live demo from dying on a rate limit.

**Depends on:** P2·3 (the loop to guard).

**Detailed tasks:**
1. **Budget caps**: per-customer and per-cycle spend ceilings; on approach, **degrade gracefully** (lower K, drop the most expensive engine) rather than overrun. Track spend into P1's run records.
2. **Per-engine isolation**: a down/slow engine must not block the cycle — isolate, continue with the others, mark partial coverage.
3. **Retry/backoff** on rate limits and transient errors.
4. **Model-drift detection**: compare `model_version` stamps across a sweep; flag mid-sweep changes (which invalidate part of a batch).
5. Re-confirm the **API-only ToS posture**; keep AI Overviews out of v1.

**Records:** reads measurement run records; enforces guards.
**Gotchas:** degrade, don't fail; a partial cycle with flagged coverage beats a blown budget or a crashed demo. Surface drift rather than silently mixing pre/post-update rows.
**Tools:** OpenAI, Perplexity, Gemini.
**DoD:** a full sweep stays in budget, survives one engine failing, and flags any model-version change mid-sweep.
**Hand-off:** measurement is production-safe; P1's ops view shows real spend.
