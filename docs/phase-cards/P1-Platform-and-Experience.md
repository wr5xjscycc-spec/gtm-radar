# P1 — Platform & Experience · Detailed Build Brief

**You own the spine.** Convex backend, the full data model, the reactive UI/live board, onboarding, reporting + claim-ladder gating, auth & workspace scoping, scheduling & compliance mechanics, email, observability, security, deployment, and submission. Everyone else writes into the records *you* define and renders through the board *you* build. If your contracts are clean, the other three lanes never block.

> Read `GTM-Radar-Architecture.md` (§2, §6, §12–§16) and `GTM-Radar-PRD.md` (§7, §11) before starting.

---

## Shared context (true for all lanes)

**The contract = the Convex record set.** Lanes never call each other directly; they read/write these records, joined on **normalized domain** (lowercase, strip `www`, strip subdomain where appropriate, resolve redirects). The 9 record types and their key fields:

1. **customer/workspace** — id, name, vertical, own_domain, competitor_domains[], query_pack_id, owner.
2. **company** — domain (PK, normalized), name, role(customer|competitor|battlefield), firmographics{size, funding_stage, headcount_growth, hiring_velocity, tech_stack}, offpage{thirdparty_mentions, reddit/ g2/ wikipedia/ review_presence, brand_search_volume, backlink_density, entity_cooccurrence}, understanding{category, icp, positioning}, coverage_flags, source_versions.
3. **page** — company_domain(FK), url(normalized), role(candidate|customer|competitor), content_features{schema_markup, comparison_table, word_count, heading_structure, freshness_days, query_term_coverage, direct_answer_first, stats_density, citation_density, quote_density, listicle_vs_prose}, extractor_version, scraped_at, cache_key.
4. **query** — id, customer_id, vertical, text, seed_source(paa|keyword|reddit|analytics|llm_expand), target_engines[].
5. **measurement** — id, query_id, page_url, engine(openai|perplexity|gemini), model_version, run_idx, appeared, cited, position, source_urls[], ts, window_tag(baseline|post|adhoc), experiment_id?; aggregates → P_cited, ci_low, ci_high, position_weight.
6. **model_fit** — id, customer_id, category, engine, coefficients[{feature, posterior_median, ci_low, ci_high, noise_flag}], prior_version, top_hypotheses[], n_companies(effective N), n_rows.
7. **experiment** — id, customer_id, pairs[{treatment_page, control_page, match_covars}], baseline_window, post_window, status(designing|awaiting_publish|running|complete|expired), publish_event_ts?.
8. **lift_result** — id, experiment_id, estimate, ci_low, ci_high, p_value, verdict(worked|no_effect|inconclusive), claim_rung, computed_at.
9. **intervention** — id, feature_changed, category, engine, measured_lift, ci_low, ci_high, experiment_id (the moat store).

**Three epistemic layers, never blurred:** *measurement* = descriptive truth · *model_fit* = hypotheses with uncertainty · *lift_result* = causal claims. Your UI must render each at its correct confidence and **never promote a hypothesis to a causal statement** (this is the claim-ladder, and you are its enforcer).

**Phase timeline (shared):** 0 Foundations → 1 Onboarding/Battlefield → 2 Enrich/Query/Feature → 3 Measurement → 4 Diagnosis → 5 Experiment/Loop → 6 Ship.

---

## Testing standard (applies to every card)

No card is **Done** until its work ships with **passing automated tests in CI** (GitHub Actions runs them on every PR — see `CONTRIBUTING.md` and `docs/TESTING.md`). External APIs are **mocked in unit tests** and exercised via **recorded fixtures** in integration tests (never live in CI — cost + flakiness). Tests land in the same PR as the code.

| Phase | P1 required tests / setup |
|---|---|
| 0 | **You create the GitHub repo + structure + CI + CODEOWNERS + PR template** (see `ORCHESTRATION.md`); Convex dev/prod deploy; **vitest** harness green; unit tests for the **domain-normalization helper** (www/subdomain/trailing-slash/redirect cases) |
| 1 | onboarding mutation tests; company-card render-state tests (loading → populated) on fixture records |
| 2 | board render tests for enrichment/query/feature panels against fixture records |
| 3 | gut-punch computation tests ("X/N" per engine) from fixture `measurement` rows; CI-rendering test; reactivity smoke |
| 4 | **claim-ladder gating tests — assert causal language CANNOT render without a `lift_result`** (the critical guard); noise-flag rendering tests |
| 5 | scheduler/compliance logic tests (14-day slot expiry, awaiting-publish gating, monthly-not-weekly cadence); experiment-console render tests |
| 6 | end-to-end happy-path test; coverage ≥ target; spend-observability assertions |

---

## Phase 0 — Spine, schema & contracts

**Goal:** stand up Convex + the record contracts so every other lane can build in parallel today.

**Why it matters:** this is the highest-leverage hour of the whole build. The 9-record contract is what lets P2/P3/P4 work against fixtures without waiting on each other. A sloppy schema or a missing domain-normalization rule causes silent join failures later (a red-team hole: www/subdomain/redirect mismatches break the company↔page↔measurement join invisibly).

**Depends on:** nothing (you go first).

**Detailed tasks:**
1. Fork the **SignalDesk** template (convex.link/growthdemo); confirm the live board renders and Convex dev+prod deploys.
2. Translate the 9 record types above into the Convex schema; commit it as the single source of truth. Include `source_versions`/`*_version` fields on every derived record (reproducibility — a red-team requirement).
3. Implement the **domain-normalization helper** and make it the *only* way any lane writes a domain/URL key. Unit-test it on www/subdomain/trailing-slash/redirect cases.
4. Establish the **Convex action pattern**: queries/mutations are pure; all external API side-effects go through actions that write results back to records. Document it so P2/P3/P4 follow it.
5. Set up **auth + workspace scoping** (Convex Auth) so every record is owned by a workspace.
6. Set up **secrets/env config** per environment (keys never reach the client).

**Records:** writes the *schema* for all; writes `customer/workspace` skeleton.
**Gotchas:** if domains aren't normalized at write time, joins fail silently — enforce it in the mutation layer, not by convention. Don't let any lane invent its own key format.
**Tools:** Convex, React, Convex Auth.
**DoD:** any teammate can write any record and see it on the board; domain helper passes its tests; dev+prod deploy green.
**Hand-off:** P2/P3/P4 can now write `measurement`/`company`/`model_fit` rows and watch them render.

---

## Phase 1 — Onboarding & company card

**Goal:** the customer entry point + the trust-building "here's what you are" card.

**Why it matters:** the PRD's Stage 1–2. The card makes the founder trust the read before the gut-punch lands; if it feels wrong, the whole demo loses credibility. Input is deliberately thin (one box, one button) — resist adding budget/goal fields.

**Depends on:** P1·0 (schema); P3·1 produces the `understanding` data you render.

**Detailed tasks:**
1. Onboarding form: **own URL + 2–3 competitor URLs**, one submit. Create the `customer/workspace` record; normalize all domains on write.
2. Attach the **vertical query_pack_id** to the workspace (pack content is P3's; you just reference it).
3. Render the **company-understanding card** (category · ICP · positioning · one-line "what you are") from the `company.understanding` fields.
4. A board state that shows the **battlefield filling** as `company` rows (role=battlefield) arrive from P3.

**Records:** writes `customer/workspace`; reads `company.understanding`, `company`(role=battlefield).
**Gotchas:** don't block the UI on enrichment — render the card progressively as fields land (reactivity). Show a clear "reading your site…" state.
**Tools:** Convex, React.
**DoD:** a real URL yields a workspace + a live, correct "what you are" card + a visibly filling battlefield.
**Hand-off:** the customer context now exists for P2 (queries) and P4 (per-customer fits).

---

## Phase 2 — Enrichment & query review surfaces

**Goal:** make the data-supply stages visible and inspectable.

**Why it matters:** P3 is generating a lot (content features, off-page signals, 300–500 queries, feature vectors). You make it auditable so the team can catch garbage early (e.g., LLM-invented queries, missing off-page coverage — both red-team holes).

**Depends on:** P3·2 (enrichment, queries, features land).

**Detailed tasks:**
1. Board panels for **content + off-page enrichment** per company/page, with `coverage_flags` surfaced (don't hide low coverage).
2. **Query-set review** view: the grounded queries with their `seed_source` tags, so anyone can see they're grounded (PAA/keyword/Reddit/analytics) vs pure `llm_expand`.
3. A **feature-vector inspector** per page for debugging extraction (shows each `content_features` field + `extractor_version`).

**Records:** reads `page`, `query`, `company.offpage`.
**Gotchas:** surface, don't suppress, low-coverage and high-`llm_expand`-ratio query sets — these are the things a judge/red-teamer attacks; visibility lets you fix them.
**Tools:** Convex, React.
**DoD:** enrichment, queries (with seed tags), and feature vectors are all live-inspectable.
**Hand-off:** team can QA P3's supply before expensive measurement runs.

---

## Phase 3 — The gut-punch board

**Goal:** the live, reactive "0 of 12" measurement view — the demo's emotional core.

**Why it matters:** PRD Stage 4 and the demo headline. This view is defensible because it shows a *measurement*, not a model. It must be per-engine (cross-engine overlap is ~11% — never imply "one answer").

**Depends on:** P2·3 (measurement rows with P_cited+CI, per engine); P1·0.

**Detailed tasks:**
1. **Per-engine citation board**: for each engine, customer vs competitors — appeared / cited / `position`, with the actual `source_urls` shown ("cited from these 3 sources").
2. Headline computation: "you: X/N · top competitor: Y/N" per engine, plus a combined view that is explicit it's an aggregate of independent engines.
3. **Measurement progress/status**: cycle running, engines done, calls made, with reactivity so the board sharpens as rows land (no polling).
4. Show **P_cited with its CI** (not a bare binary) wherever a single page's citation likelihood is displayed — uncertainty is visible, not hidden.

**Records:** reads `measurement` (aggregated P_cited, ci, position, sources, engine).
**Gotchas:** never collapse the engines into a single number without labeling it an aggregate. Show CIs — a red-team point is that non-determinism makes single draws unreliable; your UI should reflect that the value is a rate with uncertainty.
**Tools:** Convex (reactive queries), React.
**DoD:** "you 0/12, competitor 9/12, cited from these sources" renders live, per engine, with CIs, updating as the sweep runs.
**Hand-off:** the day-1 measurement value is now demoable on its own.

---

## Phase 4 — Diagnosis & reporting shell + claim-ladder gating

**Goal:** present ranked gaps honestly and **architecturally block overclaiming**.

**Why it matters:** this is where the original idea died and the patched one lives. You render the model as *ranked hypotheses with uncertainty*, never "the equation that proves you'll win." You are the enforcement point for the claim-ladder — a GEO-specialist judge will probe exactly here.

**Depends on:** P4·4 (`model_fit` with coefficients, CIs, noise_flags, top_hypotheses).

**Detailed tasks:**
1. **Ranked-gap report**: list features by impact, each annotated with its 90% CI and a **noise flag** (CI crosses zero → "not distinguishable from noise"). Visually separate the 1–3 surviving signals.
2. **Diagnosis view**: customer's own page features vs the category frontier; highlight the **top hypothesis** (the gap to test first).
3. **Claim-ladder gating (the core of this card):** implement a render guard keyed on record type — `measurement`→descriptive language; `model_fit`→hypothesis language ("correlates with", "candidate"); **causal language is impossible to render unless a `lift_result` exists.** Every claim shows a **rung badge** (Rung 1 here).
4. Copy rules: ban "add X and you'll win"; require "X correlates with citation in this category; test it."

**Records:** reads `model_fit`, customer `page` features; no `lift_result` yet so causal rungs are locked.
**Gotchas:** the whole product's credibility rests on this gate. Don't let a designer slip "proven" or "will" into hypothesis-stage copy. Show effective-N (`n_companies`) so the thinness is honest.
**Tools:** Convex, React.
**DoD:** ranked gaps render with uncertainty + noise flags; it is *technically impossible* to display a causal claim without a lift record. **This completes the day-1 product UI.**
**Hand-off:** day-1 product is shippable; the experiment loop (Phase 5) can now layer causal claims on top.

---

## Phase 5 — Experiment console + compliance & scheduling

**Goal:** drive the closed loop and the >50% ship-compliance the moat depends on.

**Why it matters:** the moat (interventional dataset) only compounds if customers actually ship the asset and the system re-measures. Red-team flagged compliance as the single biggest threat to the moat — your compliance mechanics are the mitigation. Also: weekly multi-engine re-measurement is *not* affordable, so your scheduler enforces **monthly baseline + event-driven post-publish** cadence only.

**Depends on:** P4·5 (`experiment`, `lift_result`); P2·5 (re-measurement on trigger).

**Detailed tasks:**
1. **Experiment console**: render `experiment.pairs` (treatment shown, **control hidden from the customer** — Hawthorne mitigation), status, baseline/post windows, and the lift-report surface.
2. **Compliance mechanics:** one-click-publish entry point (the publish *action* is P4's; you own the UX + gating), an **"awaiting publication"** state that blocks the experiment from "running" until publish, **14-day slot auto-expiry** (free the credits), and **email nudges** (Resend) at publish-pending and result-ready.
3. **Scheduling:** Convex cron for **monthly baseline re-measurement**; an **event-driven trigger on publish** that tells P2 to run the post-window measurement. Never schedule weekly multi-engine sweeps (cost guard).
4. **Promote the claim-ladder:** once a `lift_result` exists for an experiment, allow **Rung-2 causal** rendering ("treated pages saw +X% vs matched controls, CI […], p=…"), with the rung badge.

**Records:** reads `experiment`, `lift_result`; writes scheduler jobs, publish-pending state; emits publish/measure triggers.
**Gotchas:** keep controls invisible to the customer (or the DiD is biased). Don't let the scheduler create weekly multi-engine cycles — that breaks unit economics. Gate Rung-2 strictly on a real `lift_result`.
**Tools:** Convex (cron/scheduled functions, actions), React, Resend.
**DoD:** customer starts an experiment → gets nudged → unpublished slots expire → re-measurement fires on schedule → lift report renders at the correct rung.
**Hand-off:** the closed loop is operable end-to-end through the UI.

---

## Phase 6 — Observability, security, polish & submission

**Goal:** reliable, safe, demo-ready, submitted.

**Why it matters:** spend must be observable (the cost model is tight — ~$100–120/cycle), data must be scoped, and the demo + open-source submission are the deliverable.

**Depends on:** all lanes' Phase-6 work for integration.

**Detailed tasks:**
1. **Observability:** per-cycle **run records** (queries issued, calls made, **$ spend**, per-engine error rates) surfaced in an ops view; pipe Convex function logs.
2. **Security pass:** confirm keys live only in env config; per-workspace data scoping enforced; document the **API-only ToS posture** (no UI scraping in v1).
3. **Integration + polish:** end-to-end run, reporting polish, confirm every causal statement carries its rung badge.
4. **Demo + submission:** build the demo flow and 3-min video capture surface; submit to **vibeapps.dev / convex.link/growthhack**.

**Records:** reads all; writes run/ops records.
**Gotchas:** don't ship a demo where spend is invisible — judges (and your own unit economics) care. Keep the honesty guardrails intact under demo pressure.
**Tools:** Convex, React.
**DoD:** clean honest end-to-end demo; spend observable per cycle; submission in; security pass signed off.
**Hand-off:** product is shippable and submitted.
