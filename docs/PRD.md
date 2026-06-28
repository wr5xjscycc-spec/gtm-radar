# GTM Radar — Product Requirements Document (v2)

*Derived from a 3-round adversarial red-team + patch cycle (see `GTM-Radar-redteam-and-patches.md`). This PRD encodes the version that survived: the **causal AI-search experimentation** product, not the original "fitted equation" pitch.*

**Status:** Draft for build · **Owner:** Aarnav + Tirth · **Last updated:** 2026-06-27

---

## 1. One-liner

**GTM Radar measures whether you're cited in the AI answers your buyers trust, forms the strongest hypothesis for fixing it, then runs a *randomized experiment* — ship-vs-hold — and reports the actual citation lift with a confidence interval.** Everyone else hands you a visibility score; we prove what moved the needle.

## 2. The problem

B2B buyers increasingly ask an AI (ChatGPT, Perplexity, Gemini) before they ask Google. If you're not cited in those answers, you're invisible at the exact moment of consideration — and you can't see it happening. The emerging GEO/AEO tools tell you *that* you're invisible (a score). None of them tell you, with evidence, *what actually makes you visible* — because their feedback loops are **correlational** ("you published content and your mention-rate changed") and confounded by model drift, seasonality, and everything else you did that week.

## 3. The insight (the wedge)

The honest, defensible core is **causal measurement of citation lift via a randomized closed loop**. It is the one thing that is simultaneously:
- **True** — a randomized ship/hold design actually identifies an effect.
- **Technically real** — not an LLM rating a gap 0–100.
- **Not already shipped** by funded incumbents (Profound $155M/$1B/700+ customers ships autonomous content + a *correlational* loop; Peec/Otterly own SMB monitoring) — their data models aren't built for experiments.

Everything else (the visibility score, the multi-engine sweep, a fitted regression) is commodity or overclaim. **We protect the experiment; we treat the rest as table-stakes scaffolding.**

## 4. Target user (vertical-first)

Launch in **one** high-intent vertical (decide at kickoff; candidate: B2B SaaS in a single subcategory, e.g. project-management / HR-tech / dev-tools). Rationale: a 4-person team cannot win on breadth/funding/enterprise sales; it can win on **methodology rigor + vertical depth + curated query sets + one-click publish to that vertical's standard CMS.**

- **Primary user:** founder / head of growth / RevOps at a company that is losing AI-search visibility and has been burned by GEO snake oil — wants *proof*, not a dashboard.
- **Out of scope (v1):** enterprise multi-brand, agencies, anyone needing 10-engine coverage.

## 5. Goals & non-goals

**Goals**
- G1. Day-1 value from **measurement alone** (the "2/50 vs your competitor's 17/50" moment).
- G2. A statistically **honest** hypothesis + a runnable **randomized experiment** per customer.
- G3. Report **causal lift with a confidence interval** within one experiment cycle.
- G4. Drive **>50% ship-compliance** so the interventional dataset compounds.
- G5. Unit economics that clear **~70% gross margin** at launch pricing.

**Non-goals**
- N1. No claim of a universal "equation" or law. Per-category, per-customer, uncertainty-bounded.
- N2. No causal claim before an experiment runs. Day-1 outputs are descriptive + hypotheses.
- N3. No Google AI Overviews coverage in v1 (no API; scraping is brittle + ToS-risky).
- N4. No "continuous/weekly" multi-engine re-measurement promise (cost-prohibitive).
- N5. We do not manufacture domain authority / earned press inside the product (we route it — see §8 Tier 3).

## 6. Product principles (honesty guardrails)

1. **Measurement is descriptive truth; the model is a hypothesis generator; only the experiment is causal.** Never blur these.
2. **Flag uncertainty in the UI.** Any coefficient whose 90% interval crosses zero is labeled "not distinguishable from noise."
3. **Per-engine, not "one recipe."** Cross-engine citation overlap is ~11%; show per-engine results.
4. **State the claim-ladder rung you're on** (see §11). Never claim a higher rung than the data supports.
5. **The diagnosis includes off-page gaps even when we can't auto-fix them** — honesty over convenient scope.

## 7. The core loop (user journey)

```
1. ONBOARD      URL + 2–3 competitors + (auto) vertical query pack
2. MEASURE      Multi-engine (ChatGPT/Perplexity/Gemini) × K repeats → P(cited) per page, per engine
                → "0 of 12. Competitor cited 9. Here are the source pages." (day-1 gut-punch)
3. DIAGNOSE     Bayesian hypothesis generator over content + off-page/entity features
                → ranked gaps WITH uncertainty; top survivable signal = the experiment hypothesis
4. EXPERIMENT   Match pages into pairs → randomize treatment/control → generate + 1-click ship treatment
5. RE-MEASURE   Automatic, scheduled (4–8 wks) → DiD lift estimate with CI: "did your fix actually work?"
6. COMPOUND     Result feeds the interventional dataset → sharper hypotheses next cycle
```

## 8. Functional requirements

### 8.1 Measurement engine
- Query **3 engines**: ChatGPT (OpenAI **Responses API + `web_search`** — returns `url_citation` annotations), Perplexity (Sonar/Sonar Pro API), Gemini (Search-grounded). Capture: appears / cited / citation position / source URLs.
- **Probabilistic labels:** run each query **K times** (adaptive: start K=3, extend to K≈8 only for pages whose Wilson CI on P(cited) is still wide). Outcome = **P(cited)**, not a single binary draw.
- **Graded outcome:** weight by citation position (pos-1 ≫ pos-3) — ordinal, not binary.
- **Reality-grounded query set:** seed from keyword tools / "People Also Ask" / Reddit-forum mining / the customer's analytics, then LLM-*expand* (never pure-invent). Vertical packs are pre-curated.
- **Version-stamp** every measurement with engine + model version + timestamp.
- **Cadence:** monthly baseline re-measurement; experiment re-measurement is event-driven (on publish).

### 8.2 Hypothesis generator (the honest "equation")
- **Features — two families:**
  - *Content (page-level, prefer deterministic parses):* schema markup present, comparison table present, word count, heading structure, direct-answer-first sentence, statistics/citations/quotation density (the GEO-paper tactics), freshness, query-term coverage, listicle-vs-prose.
  - *Off-page / entity (company-level — the dominant drivers):* third-party/earned-media mention count, Reddit / G2 / Wikipedia / review-site presence, brand-search volume, backlink/entity co-occurrence. (Sourced via Fiber + Orange Slice + web search.)
- **Model:** Bayesian logistic regression, **weakly-informative priors** (Gelman 2008 Student-t) + **R2D2 shrinkage**; one model per category at cold-start. Report posterior median + **90% credible interval** per feature.
- **Honest reporting rule:** flag intervals overlapping zero as noise; surface only the 1–3 surviving signals as the experiment hypothesis.
- **Candidate/loser pool = case-control:** "losers" are pages the engine actually *retrieved/considered but didn't cite* (or rank in classic search) — not arbitrary uncited pages.
- **Graduation:** at ~15+ categories / 300+ companies, move to a hierarchical mixed-effects model with company + category + engine random effects (effective N = #companies, stated plainly).

### 8.3 Experiment engine (the moat)
- **Design:** matched-pair randomized difference-in-differences. 4-week baseline → match 6–10 page pairs (by pre-period citation rate, content type, topical cluster, from *different* clusters to limit spillover) → randomize one of each pair to treatment → 8–12 week post-period → DiD: `citation_rate ~ treatment×post + page_FE + week_FE`, SEs clustered at page level.
- **Controls are invisible to the customer** (limits Hawthorne effect).
- **Power honesty:** at v1 N (~6–10 pairs) only detects large effects (>~30% relative lift). If undetectable, the product says so — no fabricated significance.
- **Output:** lift estimate + CI + p-value + plain-English verdict ("your fix worked / didn't move it / can't tell yet").

### 8.4 Asset generation + 3-tier delivery
- **Tier 1 — Owned (automated):** generate AEO-optimized page/section for on-page + entity gaps → **one-click publish** to the vertical's CMS (WordPress / Webflow / Sanity / Contentful / Shopify).
- **Tier 2 — Guided playbooks (semi-automated):** for off-page gaps with a repeatable process (G2 listing, category-subreddit posts, Wikipedia-notability documentation) — generate step-by-step playbook + templates + submission links. Customer executes.
- **Tier 3 — Partner referral (out-of-product):** earned press / thought-leadership → referral to a GEO/PR partner for a fee. Product is explicit this is beyond its automation.

### 8.5 Compliance & re-measurement
- One-click CMS publish (kill "download→upload" friction).
- **Automatic scheduled re-measurement** (no customer action) → lift report emailed.
- **"Awaiting publication" gating** in the dashboard; experiment-slot **auto-expires in 14 days** if unpublished (credits freed).
- Target ship-rate **70–80%** (vs ~20–30% manual).

### 8.6 Reporting
- Per-engine citation share vs competitors (the gut-punch).
- Ranked gaps with uncertainty flags.
- Experiment status + causal lift report with CI.
- Explicit **claim-ladder rung** badge on every causal statement.

## 9. Architecture (high level)

- **Convex** — reactive store + live board; one record per (company, domain), co-enriched by each source, joined on domain (normalize www/subdomain/redirects to avoid silent join misses). Reactivity powers the live-filling board.
- **Fiber** — company population (`find-similar-companies`) + context/intent + some off-page signals.
- **Orange Slice** — page/content scraping + enrichment.
- **OpenAI / Perplexity / Gemini** — the answer engines + feature extraction (cheap models for extraction).
- **Ours (the protected core):** the measurement orchestrator, the Bayesian hypothesis generator, and the **randomized-DiD experiment engine** + interventional dataset.

## 10. Data model (essentials)

- `company(domain, vertical, size, funding, hiring_velocity, tech_stack, offpage_signals…)`
- `page(company_domain, url, content_features…, extracted_at, extractor_version)`
- `query(text, vertical, source_seed, engine_targets)`
- `measurement(query_id, page_url, engine, model_version, run_idx, appeared, cited, position, ts)` → aggregated to `P(cited)` with CI
- `experiment(customer, pairs[], assignment, baseline_window, post_window, status)`
- `lift_result(experiment_id, estimate, ci_low, ci_high, p_value, verdict)`
- `intervention(feature_changed, category, engine, measured_lift, ci)` ← **the compounding moat table**

## 11. The claim-ladder (what we may say, when)

| Rung | When | Honest claim |
|---|---|---|
| 1 | Day 1, one customer | "You're cited 2/50; competitor 17/50. Here are gaps ranked with uncertainty; your strongest hypothesis is X. Let's test it." |
| 2 | After 1 ship→re-measure | "Treated pages saw +X% vs matched controls (95% CI […], p=…) over this window." |
| 3 | After 10–50 experiments | "Median lift across N customers for feature X = …% (bootstrapped CI …)." |
| 4 | 100+ experiments, multi-category | "Our interventional dataset spans N experiments across M categories; measured effect sizes per feature × engine × segment." |

## 12. Success metrics

- **Activation:** % of new customers who reach the day-1 measurement gut-punch.
- **Experiment start rate / ship-compliance:** target >50% (stretch 70–80%).
- **Causal cycle completion:** % experiments returning a lift estimate.
- **Interventional dataset growth:** # completed experiments / month (moat velocity).
- **Retention:** monthly logo retention; experiments-per-account-per-quarter.
- **Margin:** gross margin ≥70% at launch pricing.

## 13. Pricing & unit economics (verified)

- **Per-cycle COGS:** ~**$100–120/customer** (3 engines, 400 queries, adaptive K, monthly), excluding AIO. Verified inputs: OpenAI `web_search` $10/1k calls + 8k input tokens (×~2 hidden sub-searches); Perplexity Sonar Pro $3/$15 per 1M + $6–14/1k requests; Gemini grounding small free tier then ~$0.005–0.019/call.
- **Pricing:** **$400–500/mo** core (≈70–76% margin) · **$99–199/mo** vertical intro tier (fewer engines / on-demand).
- **Cost levers:** adaptive sampling (−40–50%), category-level page caching (competitors overlap across customers), cheap extraction models, monthly cadence, drop AIO.
- **Hard rule:** weekly multi-engine re-measurement is **not** viable — monthly baseline + event-driven experiment re-measurement only.

## 14. Moat & defensibility

- **Primary moat:** the **proprietary interventional lift dataset** (feature × category × engine → measured causal lift). Compounds with every experiment; not reproducible by querying an LLM once.
- **Secondary:** vertical depth (curated queries, templates, CMS integrations) + open-source community goodwill.
- **Honest caveat:** this is an **execution/timing/capital** bet, gated on ship-compliance and measurement-cost funding — *not* a structural moat. Incumbents can copy the loop in ~a quarter; the dataset head-start is the defense.

## 15. Risks & mitigations (the surviving open risks)

| Risk | Mitigation | Residual |
|---|---|---|
| Unit economics (per-customer sweeps) | Adaptive sampling, caching, monthly cadence, drop AIO | Structural per-customer cost vs incumbents' shared sweeps |
| Measurement ≠ what UI users see | Responses API + sampled browser spot-checks | API/UI divergence persists; disclose |
| Pre/post confounding | Randomized matched-pair DiD with invisible controls | Low power at v1 N; spillover |
| Cold-start small-N | Bayesian shrinkage + noise flags; lead with measurement | Early coefficients are directional only |
| Diagnosis–delivery gap (off-page) | 3-tier delivery (owned/playbook/partner) | Off-page still requires customer/partner effort |
| Ship-compliance | 1-click publish, auto re-measure, gating, slot expiry | Dataset sparse if compliance <50% |
| Incumbents copy the loop | Vertical + dataset head-start + open-source | Timing bet, not structural |
| Positioning trap (monitor vs agency) | Own "the experiment," not breadth or execution | Must resist scope creep both ways |

## 16. Roadmap

- **Phase 0 (build):** Convex board + Fiber population + single-engine measure→label loop + measurement gut-punch. *(Day-1 value lives here.)*
- **Phase 1 (3 mo):** open-source the measurement+experiment core (Python); 3-engine measurement; Bayesian hypothesis generator with uncertainty flags; Tier-1 generate + 1-click publish.
- **Phase 2 (6 mo):** vertical SaaS at $99–199/mo; randomized-DiD experiment engine + automatic re-measurement + causal lift report; compliance mechanics; Tier-2 playbooks.
- **Phase 3 (12 mo):** interventional dataset at scale; hierarchical model graduation; Tier-3 partner network; position for acquisition by an incumbent needing causal measurement.

## 17. Kill criteria

Do **not** build standalone if any holds after a fair test:
- Can't fund ~$100–120/customer/month measurement COGS at target price.
- Can't drive **>50%** ship-compliance (the dataset never compounds).
- Can't pick and own **one** vertical (it converges to a feature an incumbent absorbs).

## 18. Open questions

- Which vertical first (and which CMS integrations are table-stakes there)?
- Minimum experiment N per customer to hit acceptable power without inflating cost?
- Does Perplexity Sonar (non-Pro) citation quality suffice for the measurement layer to cut cost?
- Open-source license + what stays proprietary (the interventional dataset + experiment orchestration).
- Partner(s) for Tier-3 earned-media referral.
