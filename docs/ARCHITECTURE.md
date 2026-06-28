# GTM Radar — System Architecture (v2)

*Companion to `GTM-Radar-PRD.md` and `GTM-Radar-redteam-and-patches.md`. No code — this describes components, tools, data flow, and contracts. Diagrams are ASCII.*

**Status:** Draft for build · **Owner:** Aarnav + Tirth · **Updated:** 2026-06-27

---

## 1. Purpose & scope

This document specifies how GTM Radar is assembled: every tool, what each is responsible for, how data flows between them, where the joins happen, and where our defensible IP lives. It encodes the architecture of the **causal-experiment** product (measure → hypothesize → randomized ship/hold → lift with CI), not the original "fitted equation" pitch.

## 2. Architectural principles

1. **Convex is the meeting point.** Tools do not call each other directly. Each independently **co-enriches one company/page record in Convex, joined on domain.** This is more robust in a sprint than chaining vendor APIs, and Convex reactivity makes the board fill in and the model refit live.
2. **Separation of epistemic layers** (mirrors the honesty guardrails): the **Measurement** layer produces descriptive truth; the **Model** layer produces hypotheses with uncertainty; the **Experiment** layer produces causal claims. These are different subsystems with different stores and different UI treatments — never blurred.
3. **Protected core vs commodity scaffolding.** Sourcing, enrichment, asset generation, and the live board are assembled from sponsor tools. The **Measurement Orchestrator, the Bayesian Hypothesis Generator, and the Randomized-DiD Experiment Engine** are ours and are the moat.
4. **Polyglot by necessity.** Convex (TypeScript) owns orchestration, storage, reactivity, scheduling, and the UI. Heavy statistics (Bayesian logistic, difference-in-differences) run in a **separate Python analysis service** because they are not TS-native. The two communicate over a thin job contract through Convex.
5. **Cost is a first-class design constraint.** Adaptive sampling, category-level caching, monthly cadence, and engine selection are architectural, not afterthoughts (see §11).
6. **Per-engine, never "one recipe."** Cross-engine citation overlap is ~11%; the data model and UI are per-engine throughout.

## 3. System context

```
        ┌──────────────┐         ┌─────────────────────────────────────────┐
        │   Customer    │  URL +  │              GTM RADAR                   │
        │ (growth/RevOps│ comps   │   (Convex app + Python analysis svc)     │
        │  founder)     │────────▶│                                          │
        └──────────────┘         │  Onboard → Measure → Diagnose →          │
               ▲                  │  Experiment → Re-measure → Compound      │
               │  reports,        │                                          │
               │  lift w/ CI      └───┬───────┬───────┬───────┬───────┬─────┘
               │                      │       │       │       │       │
        ┌──────┴───────┐        ┌─────▼──┐ ┌──▼───┐ ┌─▼────┐ ┌▼─────┐ ┌▼───────┐
        │ Email / board │        │ Fiber  │ │Orange│ │OpenAI│ │Perplx│ │ Gemini │
        └───────────────┘        │  (MCP) │ │Slice │ │Resp. │ │Sonar │ │ground. │
                                 └────────┘ └──────┘ └──────┘ └──────┘ └────────┘
                                  company/   page/    answer-engine layer + LLM
                                  intent/    content  feature extraction + gen
                                  off-page   scrape
                                                   │
                                           ┌───────▼────────┐
                                           │  CMS targets    │  one-click publish
                                           │ WP/Webflow/etc. │  (Tier-1 delivery)
                                           └─────────────────┘
```

External actors: the **customer**, the **answer engines** (ChatGPT/Perplexity/Gemini — the systems we *measure*), the **enrichment vendors** (Fiber, Orange Slice), and the **CMS endpoints** we publish to.

---

## 4. Complete tool inventory

Every tool in the system, its layer, role, how we access it, and notes. (★ = sponsor-provided / hackathon credits.)

### 4.1 Platform & backend
| Tool | Layer | Role | Access | Notes |
|---|---|---|---|---|
| **Convex** ★ | Backend / store / orchestration / UI reactivity | System of record; reactive queries; scheduled jobs; action functions that call external APIs; the live board | Convex cloud + React client (fork **SignalDesk** template, convex.link/growthdemo) | Also targets "Best Use of Convex." Owns the domain-join. |
| **React (Convex client)** | Frontend | The dashboard, live board, experiment console, lift reports | Comes with SignalDesk template | Reactive — board fills as data lands. |
| **Convex Auth** (or **Clerk**) | Identity | Customer accounts, workspace scoping | Convex component / Clerk integration | Pick one; Convex Auth keeps the stack minimal. |
| **Python analysis service** (ours) | Statistical compute | Runs Bayesian hypothesis fit + randomized-DiD estimation; returns coefficients/intervals/lift | Hosted as a small service (e.g., **Modal**, **Fly.io**, or **Render**) invoked by a Convex action over HTTP | Separate because stats aren't TS-native. The protected core. |

### 4.2 Answer-engine layer (what we measure)
| Tool | Role | Access | Cost (verified) |
|---|---|---|---|
| **OpenAI Responses API + `web_search` tool** ★ | Primary answer engine (ChatGPT-equivalent, grounded, returns `url_citation` source URLs) | OpenAI API | $10 / 1,000 calls + 8k input tokens/call; ~2× hidden sub-search multiplier → ≈$0.02/measured query |
| **Perplexity Sonar / Sonar Pro API** | Second answer engine | Perplexity API | $3/$15 per 1M tokens + $6–14 / 1,000 requests |
| **Google Gemini (Search grounding)** | Third answer engine | Gemini API | Small free tier, then ~$0.005–0.019/call |
| **Google AI Overviews** | *Deferred (v2+)* — no public API | Browser capture (Playwright/Browserbase) | ~$0.10+/query, brittle, ToS-risk — **excluded from v1** |

### 4.3 Enrichment & data sourcing
| Tool | Lane | Role | Access |
|---|---|---|---|
| **Fiber AI** ★ | Company / intent / off-page | Build the "battlefield" (`find-similar-companies`); firmographics, headcount growth, hiring velocity, tech stack; some third-party/earned-media signals | **MCP** (docs.fiber.ai) + REST (api.fiber.ai); $500 credits |
| **Orange Slice** ★ | Page / content | Scrape winner/loser pages; 100+ enrichments; plain-English page-feature extraction | `npx orangeslice@latest` services.* API (ctx · integrations · skills); $50 (=50k) credits |
| **SERP / keyword data** (DataForSEO **or** SerpAPI) | Query grounding + off-page | "People Also Ask," keyword volume, classic-search ranking (for the case-control candidate pool), brand-search volume | REST API |
| **Reddit API** (+ web search) | Query grounding + off-page | Mine real buyer questions from forums; detect Reddit/community presence (a dominant citation source) | REST API |

### 4.4 Intelligence layer (LLM tasks)
| Tool | Role | Access |
|---|---|---|
| **OpenAI gpt-4o-mini** ★ | Cheap, high-volume feature extraction (subjective content features) and company-understanding summary | OpenAI API |
| **OpenAI gpt-4o / o-series / Codex** ★ | Asset generation (AEO-optimized pages), playbook generation | OpenAI API / Codex |
| **OpenAI Docs MCP** ★ | Dev-time assist for building on OpenAI APIs | `codex mcp add openaiDeveloperDocs` |
| **Deterministic parsers** (ours) | JSON-LD/schema.org parse, HTML structure, table detection, word count — non-LLM, exact | In the Python/Node feature extractor |

### 4.5 Statistical / analytical toolchain (inside the Python service)
| Tool | Role |
|---|---|
| **pandas** | Row assembly, joins, aggregation of measurements → P(cited) |
| **PyMC** (or **NumPyro/Stan**) | Bayesian logistic regression with weakly-informative priors + R2D2 shrinkage (the hypothesis generator) |
| **statsmodels / linearmodels** | Difference-in-differences estimation with fixed effects + clustered standard errors (the experiment engine) |
| **scikit-learn** | Baseline/diagnostic models, matching utilities for pair construction |

### 4.6 Delivery & ops
| Tool | Role | Access |
|---|---|---|
| **CMS publish targets** | Tier-1 one-click publish of generated assets | WordPress REST, Webflow API, Sanity, Contentful, Shopify (direct or via Orange Slice integrations) |
| **Browser automation** (Playwright / **Browserbase**) | *Deferred* — AI-Overviews capture, screenshot evidence | Hosted browser |
| **Email** (Resend **or** SendGrid) | Lift reports, "awaiting publication" nudges, scheduled re-measurement results | REST API |
| **Convex scheduled functions / cron** | Monthly baseline re-measurement, experiment slot expiry, event-driven re-measurement | Native Convex |

### 4.7 Distribution
| Tool | Role |
|---|---|
| **GitHub (public)** | Open-source the measurement + experiment **core** (Python package); required open for hackathon duration |
| **vibeapps.dev / convex.link/growthhack** | Submission surface (hackathon) |

---

## 5. Component architecture

Each component is independent and communicates only through Convex records (except the Python service, which is invoked by a Convex action and writes back to Convex).

```
ONBOARD ─▶ COMPANY-UNDERSTANDING ─▶ BATTLEFIELD ─▶ ┌ CONTENT ENRICH (Orange Slice) ┐
                                    (Fiber)        ┤ OFFPAGE ENRICH (Fiber+SERP+   ├─▶ QUERY-GEN
                                                   └ Reddit)                       ┘     │
                                                                                          ▼
  REPORTING/BOARD ◀─ EXPERIMENT-ENGINE ◀─ HYPOTHESIS-GEN ◀─ FEATURE-EXTRACT ◀─ MEASUREMENT-ORCH
  (Convex live)        (Python: DiD)        (Python: Bayes)   (parsers+LLM)      (3 engines, K-repeats)
        │                    ▲                                                          │
        ▼                    └────────────── INTERVENTIONAL DATASET (moat store) ◀──────┘
   ASSET-GEN ─▶ DELIVERY (3-tier) ─▶ PUBLISH (CMS) ─▶ COMPLIANCE/SCHEDULER ─▶ (re-measure)
```

**5.1 Onboarding** — captures customer URL + 2–3 competitors; assigns the vertical query pack. Writes the seed `customer` + `company` records.

**5.2 Company-understanding** — one LLM pass (gpt-4o-mini) over the scraped site → the 4-line "here's what you are" card (category, ICP, positioning). Builds trust; feeds query-gen.

**5.3 Battlefield builder (Fiber)** — `find-similar-companies` expands to 20–40 real competitors in the category = the population of potential winners. Writes one `company` record per domain. **Sequencing rule: this runs first** — enrichment needs the domain list.

**5.4 Content enrichment (Orange Slice)** — scrapes candidate pages per company; supplies page-level content features. **Lane rule: Orange Slice = page/content only.**

**5.5 Off-page/entity enrichment (Fiber + SERP + Reddit)** — third-party/earned-media mentions, Reddit/G2/Wikipedia/review-site presence, brand-search volume, backlink/entity co-occurrence. These are the *dominant* citation drivers and must be in the model. **Lane rule: Fiber = company/intent/off-page.** Content + off-page enrichment fan out **in parallel** after the battlefield exists.

**5.6 Query generation** — seeds real buyer questions from SERP "People Also Ask," keyword data, Reddit mining, and the customer's own analytics, then LLM-*expands* (never pure-invents). Produces 300–500 grounded queries. Vertical packs are pre-curated to cut cost and improve realism.

**5.7 Measurement orchestrator (ours — protected)** — runs each query across the 3 engines, **K times** with **adaptive sampling** (start K=3; extend to K≈8 only where the Wilson CI on P(cited) is still wide). Records appears / cited / citation position / source URLs, each **stamped with engine + model version + timestamp.** Outcome per (query, page, engine) = **P(cited)** with a CI, plus position weighting. This is the descriptive-truth layer.

**5.8 Citation parser / labeler** — normalizes source URLs to domains, resolves the **case-control candidate pool** (a "loser" is a page the engine *retrieved/considered* — or ranks in classic search — but didn't cite, not an arbitrary uncited page).

**5.9 Feature extractor** — deterministic parsers for objective features (schema/JSON-LD, table presence, word count, heading structure); gpt-4o-mini for subjective ones (direct-answer-first, statistics/citation/quote density — the GEO-paper tactics). Records extractor version for reproducibility.

**5.10 Hypothesis generator (Python — protected)** — Bayesian logistic regression, weakly-informative priors + R2D2 shrinkage, **one model per category** at cold-start. Returns posterior median + **90% credible interval** per feature; flags intervals overlapping zero as **noise**; surfaces the 1–3 surviving signals as the experiment hypothesis. Graduates to a hierarchical model (company + category + engine random effects) at ~15+ categories / 300+ companies. **This is a hypothesis generator, not a deliverable.**

**5.11 Experiment engine (Python — protected, the moat)** — matched-pair randomized difference-in-differences: 4-week baseline → match 6–10 page pairs (by pre-period citation rate, content type, topical cluster, from *different* clusters to limit spillover) → randomize one per pair to treatment → 8–12 week post → DiD with page + week fixed effects, page-clustered SEs. Controls are invisible to the customer. Outputs lift estimate + CI + p-value + plain-English verdict.

**5.12 Asset generator + 3-tier delivery** — generates the AEO-optimized asset (gpt-4o/Codex). Tier-1 (owned: on-page/entity) → publish; Tier-2 (off-page playbooks: G2/Reddit/Wikipedia) → guided templates; Tier-3 (earned press) → partner referral.

**5.13 Publishing (CMS)** — one-click publish of Tier-1 assets to the customer's CMS; records publish timestamp (the experiment's treatment event).

**5.14 Compliance / scheduler (Convex)** — one-click publish, **automatic scheduled re-measurement**, "awaiting publication" gating, **14-day experiment-slot expiry**. Drives the >50% ship-rate the moat depends on.

**5.15 Reporting / live board (Convex reactive)** — per-engine citation share vs competitors (the gut-punch), ranked gaps with uncertainty flags, experiment status, causal lift report — each tagged with its **claim-ladder rung**.

**5.16 Interventional dataset (moat store)** — every completed experiment writes `feature × category × engine → measured lift (CI)`. Compounds across customers; the only asset not reproducible by querying an LLM once.

---

## 6. Data architecture

All state lives in **Convex**, one workspace per customer. Records are **co-enriched** — each vendor writes its own fields onto a shared record keyed by **normalized domain** (lowercased, `www`/subdomain-stripped, redirect-resolved) to avoid silent join misses.

**Core record types (described, not coded):**
- **Customer / workspace** — account, vertical, the customer's own domain + competitors.
- **Company** — keyed by domain; firmographics + hiring + tech stack (Fiber); off-page/entity signals (Fiber/SERP/Reddit). The unit for context features (effective N = number of companies).
- **Page** — keyed by (company domain, URL); content features + extractor version + scrape timestamp (Orange Slice + parsers).
- **Query** — text, vertical, seed source, target engines.
- **Measurement** — one row per (query, page, engine, run index): appeared, cited, position, source URLs, model version, timestamp. Aggregated → P(cited) with CI.
- **Model fit** — per category: coefficients, credible intervals, noise flags, model + prior version.
- **Experiment** — pairs, treatment/control assignment, baseline & post windows, status.
- **Lift result** — estimate, CI, p-value, verdict, claim-ladder rung.
- **Intervention** (the moat) — feature changed, category, engine, measured lift, CI.

**Layer separation in storage:** Measurement rows (descriptive) are distinct from Model-fit rows (hypotheses) which are distinct from Lift-result rows (causal). The UI reads the right layer for the right claim and never promotes a hypothesis row to a causal statement.

---

## 7. End-to-end data flow & sequencing

```
1. Onboard            customer URL + competitors            → Convex (customer, seed company)
2. Understand         scrape + 1 LLM pass                   → "what you are" card
3. Battlefield        Fiber find-similar-companies          → 20–40 company records         [FIRST]
4. Enrich (parallel)  Orange Slice (content) ‖ Fiber+SERP+Reddit (off-page)  → page+company features
5. Query-gen          SERP/PAA/Reddit seed → LLM expand     → 300–500 grounded queries
6. Measure            3 engines × adaptive-K repeats        → measurement rows (P(cited), versioned)
7. Label              case-control candidate pool           → winner/loser at page level
8. Extract features   deterministic + gpt-4o-mini           → page feature vectors
9. Hypothesize        Python: Bayesian fit                  → coefficients + CIs + noise flags
10. Diagnose          customer page vs frontier             → ranked gaps + top hypothesis
11. Experiment        match pairs → randomize → generate → publish treatment
12. Re-measure        scheduled, event-driven on publish    → DiD lift + CI
13. Compound          write intervention row                → moat dataset; sharpen next cycle
```

Critical-path sequencing: **source the company list first** (Fiber needs domains), then **fan out content + off-page enrichment in parallel**, then queries, then measure, then fit, then experiment. The Convex board renders each stage live as rows land.

---

## 8. Measurement subsystem (depth)

- **Engines & contracts:** OpenAI Responses API with `web_search` (citations via `url_citation` annotations — *not* plain chat-completions, which return no citations); Perplexity Sonar/Sonar Pro (citations native); Gemini grounded (citations via grounding metadata). Each adapter normalizes to a common `{appeared, cited, position, sources[]}` shape.
- **Repetition & labels:** K-repeats convert a noisy binary into an estimated **P(cited)** with a confidence interval — non-determinism becomes *measured uncertainty*, not label noise. Position weighting captures that a #1 citation ≫ a #3 citation.
- **Adaptive sampling:** stop repeating a page once its Wilson interval is tight or clearly excludes the midpoint; only ambiguous pages get full K. ~40–50% call reduction.
- **Versioning:** every row stamped with engine + model version; a mid-sweep model update is detectable and isolatable rather than silently corrupting the batch.
- **Cadence:** monthly baseline re-measurement; experiment re-measurement is event-driven on publish.

## 9. Statistical & experiment core (depth, conceptual)

- **Cold-start model:** Bayesian logistic with weakly-informative priors (shrinks hard at small N) + R2D2 shrinkage; reports wide credible intervals honestly; the 80–90% of features whose intervals cross zero are labeled noise. The product **leads with the measurement gut-punch**, which is valid on day 1, and treats the model as a hypothesis generator.
- **Causal layer:** randomized matched-pair DiD removes model drift, seasonality, concurrent SEO, and regression-to-mean (the control arm absorbs them). Residual threats (spillover, low power at small N) are disclosed, not hidden. At v1 N only large effects (>~30%) are detectable — the product says "can't tell yet" rather than fabricating significance.
- **Claim-ladder gating:** the reporting layer is only permitted to render a causal statement when a lift-result row of the appropriate rung exists. This is an architectural guard against overclaiming.

## 10. External integration map

| Integration | Direction | Mechanism | Failure handling |
|---|---|---|---|
| Fiber | inbound enrichment | MCP + REST, via Convex action | retry; degrade to fewer companies |
| Orange Slice | inbound enrichment | package API, via Convex action | retry; skip page, flag low-coverage |
| OpenAI / Perplexity / Gemini | inbound measurement + LLM | REST, via Convex action | per-engine isolation; a down engine doesn't block others |
| SERP / Reddit | inbound seeding/off-page | REST | cache; fall back to LLM-expand only |
| Python analysis service | round-trip | Convex action → HTTP → write back | job status in Convex; idempotent re-runs |
| CMS (WP/Webflow/…) | outbound publish | REST/OAuth | publish receipt = treatment event; manual fallback |
| Email | outbound | REST | non-blocking |

**Convex actions** wrap every external call (Convex queries/mutations can't do side-effects). Long-running work (full measurement sweeps, the Python fit) runs as scheduled actions with status written back so the UI stays reactive.

## 11. Cost & rate-limit architecture

- **Per-cycle target:** ~$100–120/customer (3 engines, 400 queries, adaptive K, monthly), excluding AI Overviews.
- **Levers, by design:** adaptive sampling (−40–50%); **category-level page caching** (battlefield competitors overlap across customers in the same vertical — cache their extractions); cheap models for extraction; monthly cadence; **drop AI Overviews** (no API). 
- **Budget guards:** per-customer and per-cycle spend caps enforced in the orchestrator; a cycle degrades (fewer repeats / fewer engines) rather than overrunning.
- **Structural note:** unlike incumbents who amortize one category sweep across all customers, our query sets are customer-specific, so cost is per-customer — this is why weekly multi-engine re-measurement is excluded.

## 12. Reactivity & live experience

Convex's reactive queries drive the live board: as measurement rows land, the per-engine citation share, the filling battlefield, and the (uncertainty-flagged) hypothesis update without polling. The "0 of 12 → competitor in 9" moment and the experiment status are live views over the same store.

## 13. Security, compliance & data handling

- **API keys / secrets** in Convex environment config; never in the client.
- **Customer data** scoped per workspace; the interventional dataset stores feature-level lift, not customer-identifying content.
- **ToS posture:** v1 uses *official APIs only* (no scraping of answer-engine UIs). Browser capture for AI Overviews is explicitly deferred precisely because it carries IP-blocking/CAPTCHA/ToS risk.
- **Reproducibility:** model + extractor + engine versions are stored on every derived row.

## 14. Observability

- Convex function logs + per-cycle run records (queries issued, calls made, spend, engine error rates).
- Model-version drift detection from measurement stamps.
- Experiment audit trail: assignment, publish receipt, re-measurement windows.

## 15. Deployment & environments

- **Convex** cloud (dev + prod deployments).
- **Python analysis service** on a lightweight host (Modal / Fly.io / Render), stateless, invoked per fit/DiD job.
- **Frontend** served with the Convex React app.
- Secrets per environment; the public **GitHub** repo carries the open-source core.

## 16. Open-source boundary

- **Open-sourced:** the measurement + experiment **methodology core** (engine adapters' interfaces, adaptive-sampling logic, the DiD/Bayesian analysis package). Builds community around "causal GEO" and satisfies the hackathon open-source rule.
- **Proprietary:** the **interventional dataset**, the vertical query packs, the experiment orchestration/compliance product, and the hosted service. The moat is the data and the loop, not the algorithm.

## 17. Tool summary (one glance)

- **Backend/UI/orchestration/scheduling:** Convex (+ React client, Convex Auth) ★
- **Answer engines (measured):** OpenAI Responses API + web_search ★, Perplexity Sonar, Gemini grounded *(AI Overviews deferred)*
- **Company/intent/off-page:** Fiber (MCP + REST) ★
- **Page/content scrape + enrich:** Orange Slice ★
- **Query seeding & off-page mining:** SERP/keyword API (DataForSEO/SerpAPI), Reddit API
- **LLM tasks:** OpenAI gpt-4o-mini (extraction/understanding) ★, gpt-4o/o-series/Codex (generation) ★, OpenAI Docs MCP ★
- **Stats core (ours):** Python service — pandas, PyMC/NumPyro, statsmodels/linearmodels, scikit-learn
- **Delivery:** CMS APIs (WordPress/Webflow/Sanity/Contentful/Shopify); Browserbase/Playwright *(deferred)*; Resend/SendGrid (email)
- **Distribution:** GitHub (OSS core), vibeapps.dev / convex.link/growthhack (submission)

*Load-bearing pricing in this doc was web-verified (OpenAI web_search, Perplexity Sonar) during synthesis; see `GTM-Radar-redteam-and-patches.md` for sources and the full reasoning trail.*
