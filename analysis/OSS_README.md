# gtm-radar — Open Source Methodology Core

This document defines the boundary between what ships as **open-source methodology** and what stays **proprietary**. The distinction is deliberate: the algorithms are a commodity, the data + loop are the moat.

---

## Open Source — The Methodology Core

Everything in `analysis/src/` — the algorithms that drive measurement, hypothesis generation, and causal lift estimation — is open source under a permissive license (MIT / Apache 2.0). This includes:

| Module | What it does |
|---|---|
| `src/bayesian.py` | Beta regression with R2D2-style shrinkage — posterior median + 90% HDI per feature, noise flag |
| `src/did.py` | Difference-in-differences with page-clustered SEs, power-honesty guard, synthetic panel simulator |
| `src/matching.py` | Cross-cluster NearestNeighbors — spillover-aware experiment-pair construction |
| `src/experiment.py` | Experiment design: matching + randomization → Experiment record |
| `src/models.py` | Pydantic contracts: FitJobRequest/Response, LiftResult, Experiment, Intervention, etc. |
| `src/rows.py` | Measurement ↔ page ↔ company join into feature matrices |
| `src/winner_loser.py` | CI-width-weighted row construction, per-engine grouping, effective-N tracking |
| `src/delivery.py` | 3-tier delivery: CMS payload, off-page playbook, partner referral stub |
| `src/assets.py` | GPT-4o AEO-optimised content generation (BYO API key) |
| `src/intervention.py` | Moat store writer |
| `src/baseline.py` | Ridge regression yardstick |
| `src/scale_path.py` | Hierarchical-model graduation plan |

**Canonical reference:** `docs/CONTRACT.md` — the 9-record interface between lanes.

**Why open-source:** the hackathon requirement, community adoption, academic reproducibility, and because the methodology is not the defensible asset — anyone can run a Beta regression.

---

## Proprietary — The Moat

The following are **never open-sourced**. They ship in the product but stay behind closed walls.

| Asset | Why it's proprietary |
|---|---|
| **Interventional dataset** (intervention rows) | Every completed experiment — (feature_changed × category × engine → measured_lift + CI). This dataset compounds over time: each lift estimate improves the next experiment's priors. A competitor can clone the algorithms but they start with zero intervention history. |
| **Vertical packs** (pre-trained within-category models, category-specific priors, off-page gap patterns per vertical) | Category-specific knowledge is expensive to acquire. Pre-trained category models + gap heuristics represent thousands of measurement runs. |
| **Orchestration layer** (Convex functions, scheduling, measurement dispatch, experiment lifecycle, UI) | The algorithms are synchronous Python functions; the orchestration that sequences them, manages state, and presents results is the execution advantage. The Convex functions in `platform/` and `convex/` are proprietary. |
| **Measurement data** (raw `measurement` rows from answer-engine queries) | Raw query × page × engine × run measurement data is the input fuel. The open-source core consumes measurement data; the data collection is proprietary. |
| **Company / page enrichment** (sourcing/ pipeline outputs) | The enriched feature columns (thirdparty_mentions, reddit_presence, etc.) are produced by the closed-source P3 pipeline. |
| **Customer / workspace records** | Customer-specific configuration, query packs, and competitor lists. |

**The bottom line:** anyone can use `src/bayesian.py` + `src/did.py` on their own data. But the *compounding dataset* of what works in each category × engine — that's the defensible asset. It grows with every experiment and cannot be replicated without running the same loop for years.

---

## Deferred: AI-Overviews scraping (Browserbase / Playwright)

The v1 product measures OpenAI `chatgpt-answer` and (dormant) Perplexity / Gemini engines via the P2 `measurement/` lane. Expanding to **AI Overviews** (Google's AI-generated search summaries) requires Browserbase or Playwright-based scraping of Google SERPs.

**This is explicitly deferred out of v1** for two reasons:
1. **Google ToS risk:** scraping AI Overviews is a Terms-of-Service grey area. Automated Google scraping has historically led to IP blocks, legal threats, and captcha escalation. Shipping v1 requires a defensible ToS position.
2. **Fidelity uncertainty:** AI Overviews are dynamic, personalised, and rapidly evolving. A measurement adapter built today may produce non-reproducible results tomorrow.

When revisited, the planned approach is:
- Proxy through Browserbase (residential IPs, captcha handling) — never direct scraping.
- Adapter in `measurement/` following the existing `BaseEngineAdapter` pattern.
- Strict rate limiting + per-customer opt-in.

---

## Boundary summary

| Ships open source | Stays closed |
|---|---|
| Measurement + hypothesis + causal estimation algorithms | Interventional dataset (lift history) |
| Pydantic contracts (record shapes) | Vertical packs (pre-trained category models) |
| Synthetic test data generators | Orchestration (Convex / scheduling / UI) |
| Documentation + methodology whitepaper | Raw measurement and enrichment data |
| Experiment design tools (matching + randomization) | Customer / workspace records |
| Delivery tier-2/3 playbook logic | AI-Overview scraping adapters (deferred) |
