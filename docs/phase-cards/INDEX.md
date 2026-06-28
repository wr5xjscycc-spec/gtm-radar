# GTM Radar — Phase Cards (4-person build plan) · INDEX

*Work split into 4 component lanes (one owner each), each progressing through **7 phases (0–6)** with a shared integration milestone at the end of every phase. Each lane has a **detailed, self-contained brief** (link below) so an agent/person can load only their own context.*

## Per-person briefs (detailed)

| Lane | Owner | Detailed brief | Component |
|---|---|---|---|
| **P1** | Platform & Experience | [`phase-cards/P1-Platform-and-Experience.md`](phase-cards/P1-Platform-and-Experience.md) | Convex spine, data model, live board, reporting + claim-ladder gating, auth, scheduling/compliance, email, observability, security, deploy, submission |
| **P2** | Measurement Engine | [`phase-cards/P2-Measurement-Engine.md`](phase-cards/P2-Measurement-Engine.md) | 3 answer-engine adapters, K-repeats, adaptive sampling, citation parsing, case-control labeling, versioning, drift, cost guards |
| **P3** | Sourcing & Enrichment | [`phase-cards/P3-Sourcing-and-Enrichment.md`](phase-cards/P3-Sourcing-and-Enrichment.md) | Battlefield (Fiber), content + off-page enrichment, query-gen, feature extraction, caching, vertical pack |
| **P4** | Intelligence & Loop | [`phase-cards/P4-Intelligence-and-Loop.md`](phase-cards/P4-Intelligence-and-Loop.md) | Python stats (Bayesian hypotheses + randomized-DiD), asset gen + 3-tier delivery + CMS publish, interventional dataset (moat) |

Each brief contains: a **shared-context header** (the 9-record contract + the lane's non-negotiable red-team facts), a **Testing standard** (per-phase required tests), then **7 phase cards**, each with *Goal · Why it matters · Depends on · Detailed tasks · Records read/written · Gotchas · Tools · Definition of Done · Hand-off*.

**Repo & orchestration:** the build lives in the `gtm-radar/` repository — see its `README.md`, `ORCHESTRATION.md` (lanes, branches, sync, the shared contract), `CONTRIBUTING.md` + `docs/TESTING.md` (testing standard + CI), `docs/CONTRACT.md` (the 9-record Phase-0 schema all agents agree first), and `prompts/INITIAL_PROMPT.md` (the architecture-referencing kickoff prompt each agent receives). **Phase 0 includes the repo/test-harness setup itself** (P1 creates the repo + CI; each lane wires its own harness — see each brief's Testing standard, Phase 0 row).

Companion docs: `GTM-Radar-Architecture.md` · `GTM-Radar-PRD.md` · `GTM-Radar-redteam-and-patches.md`.

---

## The shared contract (every lane builds against this)

Lanes never call each other directly — they read/write the **Convex record set**, joined on **normalized domain** (P1 owns the helper). The 9 record types: `customer/workspace · company · page · query · measurement · model_fit · experiment · lift_result · intervention`. Three epistemic layers, never blurred: **measurement = descriptive truth · model_fit = hypotheses w/ uncertainty · lift_result = causal claims.** (Full field list is in each brief's header.)

---

## Shared phase timeline & milestones

| Phase | Theme | 🎯 Integration milestone |
|---|---|---|
| **0** | Foundations & Contracts | Thin slice runs end-to-end on seed data |
| **1** | Onboarding & Battlefield | Company understood + 20–40 competitors sourced |
| **2** | Enrichment, Queries & Features | Enriched rows + grounded query set + full feature vectors |
| **3** | Measurement (the signal) | Real per-engine P(cited) + CI — the "0 of 12" gut-punch is live |
| **4** | Diagnosis & Hypothesis | Ranked gaps w/ uncertainty + top hypothesis — **shippable day-1 product** |
| **5** | Experiment, Delivery & Loop | Randomized ship/hold → **causal lift with a CI** — the moat |
| **6** | Hardening, Cost, Honesty & Ship | Reliable, cost-bounded, honest, open-sourced, submitted |

**Sync cadence:** build Phase-0 contracts together; then work in parallel against the records; re-sync at each 🎯 before the next phase.

---

## Person × Phase matrix (cross-view)

| | **P1 Platform** | **P2 Measurement** | **P3 Sourcing** | **P4 Intelligence** |
|---|---|---|---|---|
| **0 Foundations** | Schema + spine + board | OpenAI adapter, 1 citation | 1 battlefield (Fiber) | Stats service skeleton |
| **1 Onboarding** | Onboarding + company card | Engine accounts + contract | Battlefield + firmographics + understanding | Fit-job contract + row assembly |
| **2 Enrich/Query/Feature** | Enrichment + query review UI | Dispatch harness + parser + labeling | **Content+off-page enrich + query-gen + features** | Matching utils + real feature pipeline |
| **3 Measurement** | Gut-punch board + progress | **3 engines + P(cited)+CI + adaptive K** | Candidate pool + extractor hardening | Winner/loser row construction |
| **4 Diagnosis** | Reporting + claim-ladder gating | Label quality for model | Join integrity + coverage flags | **Bayesian hypothesis generator** |
| **5 Experiment/Loop** | Experiment console + compliance/cron | Experiment re-measurement | Category caching (cost) | **DiD + delivery + moat dataset** |
| **6 Ship** | Observability + security + submit | Cost guards + reliability + drift | Vertical pack + coverage QA | OSS core + honesty audit + scale path |
| **🎯** | thin slice → … → submitted | … → gut-punch → … | … → enriched rows → … | … → day-1 model → closed loop |

**(bold = each lane's heaviest phase / core deliverable.)**

---

## Architecture coverage checklist (nothing dropped)

Every element of `GTM-Radar-Architecture.md` mapped to its owner · phase:

- **Convex backend / store / actions / reactivity** → P1·0, P1·3
- **Data model (9 record types) + domain-join normalization** → P1·0
- **React live board / SignalDesk fork** → P1·0, P1·3
- **Auth / workspace scoping** → P1·0
- **Onboarding (URL + competitors)** → P1·1
- **Company-understanding LLM pass + "what you are" card** → P3·1 (data) · P1·1 (UI)
- **Battlefield builder — Fiber `find-similar-companies` (MCP+REST)** → P3·0, P3·1
- **Fiber firmographics (size/funding/headcount/hiring/tech stack)** → P3·1
- **Orange Slice content scrape + page features** → P3·2
- **Off-page/entity enrichment (third-party mentions, Reddit/G2/Wikipedia/review, brand-search, backlinks)** → P3·2
- **SERP/keyword (DataForSEO/SerpAPI) — PAA, volume, classic-search ranking** → P3·2, P3·3
- **Reddit API (query mining + presence)** → P3·2
- **Query generation (seed + LLM-expand, vertical pack)** → P3·2, P3·6
- **Feature extraction (deterministic parsers + gpt-4o-mini, extractor versioning)** → P3·2, P3·3
- **OpenAI Responses API + web_search adapter** → P2·0
- **Perplexity Sonar adapter** → P2·3
- **Gemini grounding adapter** → P2·3
- **Common normalized engine shape** → P2·1
- **K-repeats → P(cited)+CI + position weighting** → P2·3
- **Adaptive sampling (Wilson CI) — cost lever** → P2·3
- **Citation parser / URL→domain normalization** → P2·2
- **Case-control candidate-pool labeling** → P2·2 (logic) · P3·3 (pool)
- **Version stamping + model-drift detection** → P2·3, P2·6
- **Cost/budget guards + graceful degradation** → P2·6
- **Per-engine isolation + retry/backoff** → P2·6
- **Cadence (monthly baseline + event-driven re-measure)** → P1·5 (schedule) · P2·5 (execute)
- **Python analysis service (hosted)** → P4·0
- **Bayesian logistic (priors + R2D2) + 90% CI + noise flags** → P4·4
- **Hierarchical-model graduation path** → P4·6
- **Randomized matched-pair DiD (FE + clustered SEs, spillover, power honesty)** → P4·5
- **Lift result (estimate/CI/p/verdict) + claim-ladder rungs** → P4·5 (data) · P1·4/P1·5 (gating UI)
- **Interventional dataset (moat store)** → P4·5
- **Asset generation (gpt-4o/Codex)** → P4·5
- **3-tier delivery (owned / playbook / partner)** → P4·5
- **CMS publish integrations** → P4·5
- **Compliance (one-click publish, awaiting-publication gating, 14-day expiry, nudges)** → P1·5
- **Reporting / gut-punch / claim-ladder gating UI** → P1·3, P1·4, P1·5
- **Cost architecture (caching, cheap models, monthly cadence, drop AIO)** → P2·3/P2·6, P3·5, P1·5
- **Security / ToS posture / reproducibility** → P1·6, P2·6, P4·6
- **Observability (run records, spend, logs)** → P1·6
- **Deployment / environments** → P1·0, P1·6
- **Open-source boundary** → P4·6
- **Distribution (GitHub OSS + vibeapps submission)** → P4·6 (OSS) · P1·6 (submission)
- **Deferred: Browser capture for AI Overviews** → P4·6 (noted out-of-v1)
