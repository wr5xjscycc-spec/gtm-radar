# P4 — Intelligence & Loop · Detailed Build Brief

**You own the moat.** The Python analysis service (Bayesian hypothesis generator + randomized-DiD experiment engine + interventional dataset), and the asset generation + 3-tier delivery + CMS publish that closes the loop. The entire 3-round red-team concluded that **the one thing that is honest, technically real, AND not already shipped by funded incumbents is causal lift measurement via the closed loop** — that's your lane. You are also the lane most able to *destroy* the product by overclaiming, so honesty discipline is part of your job, not a nicety.

> Read `GTM-Radar-Architecture.md` (§4.1, §4.5, §5.10–5.16, §9) and `GTM-Radar-redteam-and-patches.md` (Patch C, Patch D, Patch F, Round-3 Lane 2) before starting.

---

## Shared context (true for all lanes)

**The contract = the Convex record set**, joined on **normalized domain** (P1's helper). Convex is TypeScript; your stats run in a **separate Python service** invoked by a Convex action over HTTP, writing results back to records. The records you produce:

- **model_fit** — id, customer_id, category, engine, coefficients[{feature, posterior_median, ci_low, ci_high, **noise_flag**}], prior_version, **top_hypotheses[]**, **n_companies (effective N)**, n_rows.
- **experiment** — id, customer_id, pairs[{treatment_page, control_page, match_covars}], baseline_window, post_window, status.
- **lift_result** — id, experiment_id, estimate, ci_low, ci_high, p_value, verdict(worked|no_effect|inconclusive), **claim_rung**, computed_at.
- **intervention** — id, feature_changed, category, engine, measured_lift, ci_low, ci_high, experiment_id (the **moat store**).

You consume: **measurement** (P_cited+CI, per engine, window-tagged) from P2; **page/company features** (content + off-page) from P3.

**The non-negotiable intelligence facts (from the red-team) — internalize these or you rebuild the broken product:**
1. **Correlation ≠ causation.** Coefficients from observational data do NOT justify "add X to win." The model is a **hypothesis generator**; causation is earned only by the randomized experiment. Never let `model_fit` language imply causation.
2. **Pseudo-replication.** Context (company-level) features are inherited across page rows; **effective N = number of companies (~20–40), not the row count.** Always report `n_companies`, cluster by company, and don't trust company-feature coefficients as if N were thousands.
3. **EPV ≈ 1–3 at cold-start.** ~15 features over ~20–40 effective units → coefficients blow up without regularization. Use **weakly-informative priors + R2D2 shrinkage**; expect 80–90% of coefficients to be noise and **flag them**.
4. **No "novel interaction discovery."** ~105 feature pairs ⇒ spurious interactions by chance (garden of forking paths). Do not market discovered interactions; present survivors as hypotheses to test.
5. **Pre/post needs a control.** A single-group before/after is confounded (model drift, seasonality, the customer's other SEO). Use **randomized matched-pair difference-in-differences** with invisible controls.
6. **Lead with measurement; the equation is secondary.** Day-1 value is P2's measurement; your model is the honest hypothesis layer on top.

**Phase timeline:** 0 Foundations → 1/2 prep → 3 row construction → 4 **Bayesian generator** → 5 **DiD + delivery (the moat)** → 6 OSS + honesty audit.

---

## Testing standard (applies to every card)

No card is **Done** until its work ships with **passing automated tests in CI** (see `CONTRIBUTING.md` / `docs/TESTING.md`). The Python service uses **pytest**; LLM/CMS calls are **mocked in unit tests** and run via **recorded fixtures** in integration tests. **Statistical code is tested on synthetic data with a known ground truth** (plant an effect, recover it) — this is how we prove honesty, not just correctness. Tests land with the code.

| Phase | P4 required tests / setup |
|---|---|
| 0 | analysis-service scaffold + **pytest** harness green in CI; **Convex↔Python round-trip test** (mocked) returning a `model_fit` |
| 1 | row-assembly tests; assert every row carries its **company cluster id**; fit-job contract schema test |
| 2 | matching-utility tests (pairs formed **across** topical clusters — spillover guard); feature-pipeline join test |
| 3 | winner/loser construction tests; **effective-N (`n_companies`) computed correctly**; per-engine separation test |
| 4 | **Bayesian recovery test on synthetic data** (plant signals → recover signs; null features get `noise_flag`); shrinkage-at-small-N test (no coefficient blow-up at EPV≈1–3); top-hypotheses selection test |
| 5 | **DiD recovery test on a simulated panel with a known lift** (estimate within CI; correct sign); randomization/assignment tests; **power-honesty test** (returns `inconclusive` at tiny N rather than a false positive); `intervention`-row write test |
| 6 | coverage ≥ target; **honesty-audit assertion tests** (no causal output emitted without a `lift_result`); OSS package builds & installs |

---

## Phase 0 — Stats service skeleton

**Goal:** prove the Convex ⇄ Python contract.

**Why it matters:** the polyglot boundary (TS orchestration ↔ Python stats) is the riskiest integration in your lane. Prove the round-trip before building anything statistical.

**Depends on:** P1·0 (action pattern, schema).

**Detailed tasks:**
1. Stand up the **Python analysis service** (Modal / Fly / Render), callable from a Convex action; health-check round-trip.
2. Return a **dummy coefficient set** from fixture rows, written back as a `model_fit` record.

**Records:** reads a fit request (fixtures); writes a dummy `model_fit`.
**Gotchas:** nail down request/response serialization and timeouts now (Bayesian fits can be slow — design for async job status, not a blocking call).
**Tools:** Python service, Convex action.
**DoD:** Convex → Python → Convex round-trip works with a dummy fit.
**Hand-off:** P1 can render `model_fit`; the contract is proven.

---

## Phase 1 — Fit-job contract & row assembly

**Goal:** the data pipeline into the model.

**Why it matters:** clean row assembly (with correct keys and effective-N tracking) is what makes later honesty possible.

**Depends on:** P4·0; P2·1 (measurement contract).

**Detailed tasks:**
1. Define the **fit-job request/response contract** (inputs: category, engine, rows; outputs: coefficients + CIs + noise flags + top_hypotheses + n_companies).
2. **pandas row assembly** from fixture `measurement` + `page`/`company` feature records into page-level rows; carry a **company cluster id** on every row (for pseudo-replication handling).
3. A **scikit-learn baseline** classifier as a yardstick (not shipped).

**Records:** reads fixture `measurement` + features; writes assembled tables, baseline metrics.
**Gotchas:** every row must carry its company cluster id from the start — retrofitting it later is painful and it's essential for clustered inference.
**Tools:** Python (pandas, scikit-learn).
**DoD:** real-shaped rows flow into a baseline fit and back as a `model_fit`.
**Hand-off:** the pipeline shape is fixed for the real model.

---

## Phase 2 — Matching utilities & feature pipeline

**Goal:** prep for both the model and the experiment.

**Why it matters:** the experiment's validity hinges on good page matching; build it early and test it on real features.

**Depends on:** P4·1; P3·2 (real features).

**Detailed tasks:**
1. Build **page-matching utilities**: match pages by pre-period citation rate, content type, and topical cluster (used later to form experiment pairs). Match across *different* topical clusters to limit spillover.
2. Wire the **real feature pipeline** (content + off-page joined on domain from P3); confirm context features inherit per company.

**Records:** reads real features; produces matching utilities + real-row pipeline.
**Gotchas:** matching on topical cluster but pairing *across* clusters is the spillover mitigation — don't pair two pages competing for the same query (the treatment could cannibalize its own control).
**Tools:** Python (pandas, scikit-learn).
**DoD:** real rows assemble; matching produces sensible candidate pairs on test data.
**Hand-off:** ready for real row construction and, later, experiment pairing.

---

## Phase 3 — Winner/loser row construction

**Goal:** turn measurement + labels + features into modelable rows.

**Why it matters:** the unit is the **page**, the cluster is the **company**, the outcome is **P(cited)** (a rate, not a binary) — encoding these correctly is what keeps the later model honest.

**Depends on:** P2·3/P2·4 (P_cited + case-control labels), P3·4 (clean joined features).

**Detailed tasks:**
1. Consume **P_cited** + **case-control labels** (winner/loser) + features; construct **page-level rows per category, per engine**.
2. Attach the **company cluster id** and record **`n_companies`** (effective N) and `n_rows` per category/engine.
3. Optionally weight rows by P_cited certainty (CI width) so noisy labels count less.

**Records:** reads `measurement` + labels + features; writes per-category/engine modeling tables.
**Gotchas:** keep page-level and company-level features clearly separated; the model must know which is which (company features have tiny effective N). Per engine — don't pool engines (11% overlap).
**Tools:** Python (pandas).
**DoD:** clean per-category, per-engine row tables with effective-N recorded, ready to fit.
**Hand-off:** the Bayesian generator can fit honestly.

---

## Phase 4 — Bayesian hypothesis generator (honest)  *(heavy phase)*

**Goal:** the day-1 model — ranked gaps with honest uncertainty.

**Why it matters:** this is where the original "fitted equation" overclaim is replaced with a defensible hypothesis generator. A GEO-specialist judge will attack exactly here; your shrinkage + noise-flagging is the defense.

**Depends on:** P4·3.

**Detailed tasks:**
1. **Bayesian logistic** (PyMC/NumPyro) per category, per engine: **weakly-informative priors** (e.g. Student-t) + **R2D2 shrinkage**. Standardize predictors.
2. Output **posterior median + 90% credible interval** per feature; **flag intervals crossing zero as noise** (`noise_flag=true`); expect 80–90% flagged.
3. Surface the **top 1–3 surviving signals** as `top_hypotheses` — these become the experiment's hypothesis, not a "law."
4. Emit the **claim-ladder Rung-1 payload** for P1 (hypothesis-language only).
5. Record `n_companies` so the UI can show how thin the data is.

**Records:** reads modeling tables; writes `model_fit` (coefficients, CIs, noise_flags, top_hypotheses, n_companies).
**Gotchas:** do NOT report unregularized coefficients (they explode at EPV≈1–3). Do NOT present any interaction as a discovery. Make the noise flags load-bearing in the output, not a footnote.
**Tools:** Python (PyMC).
**DoD:** a real, honestly-uncertain ranked gap list + top hypothesis for the test customer, with 80–90% of features correctly flagged as noise. **Completes the day-1 product** (with P1·4).
**Hand-off:** P1 renders diagnosis; the experiment can target the top hypothesis.

---

## Phase 5 — Experiment engine, delivery & the moat  *(heavy phase)*

**Goal:** the closed loop and the defensible interventional dataset.

**Why it matters:** this is the entire differentiation. Everyone else reports a score; you run the **randomized experiment** and measure the **causal lift with a CI**, then bank it as proprietary data. This is the moat the 3-round analysis converged on.

**Depends on:** P4·4 (hypothesis), P1·5 (experiment console + triggers), P2·5 (windowed re-measurement), P3·6 (CMS targets).

**Detailed tasks:**
1. **Experiment design:** from a `model_fit` hypothesis, select 6–10 page pairs (P4·2 matching), **randomize** one of each pair to treatment, write the `experiment` record (controls flagged invisible-to-customer).
2. **DiD estimation** (statsmodels/linearmodels): `citation_rate ~ treatment×post + page_FE + week_FE`, **page-clustered SEs**, on P2's windowed baseline/post measurements. Mitigate **spillover** (cross-cluster pairs); be honest about **power** (report `inconclusive` at small N — don't fabricate significance).
3. **Lift result:** estimate + **CI** + p-value + plain-English `verdict`; set `claim_rung=2`. Write `lift_result`.
4. **Asset generation** (gpt-4o/Codex) for treatment pages (AEO-optimized, targeting the top hypothesis + the queries from P3).
5. **3-tier delivery:** Tier-1 generate + **one-click CMS publish** (WordPress/Webflow/… from P3's vertical targets); Tier-2 **playbook** generation for off-page gaps (G2/Reddit/Wikipedia) the generator can't auto-fix; Tier-3 **partner-referral** hook for earned press.
6. **Moat write:** append an `intervention` row (feature_changed × category × engine → measured_lift + CI) per completed experiment.

**Records:** reads `model_fit`, `experiment`, windowed `measurement`; writes `experiment`, `lift_result`, `intervention`, generated assets, publish events.
**Gotchas:** measure both arms identically (P2 owns this — coordinate). Keep controls invisible. Report honest verdicts including "can't tell yet." The off-page gaps are the ones you *can't* auto-fix — route them to Tier-2/3 rather than pretending a page edit fixes them (red-team: the diagnosis-delivery gap).
**Tools:** Python (statsmodels/linearmodels), gpt-4o/Codex, CMS APIs.
**DoD:** ship-vs-hold runs and returns an honest causal lift report (estimate + CI + verdict); the `intervention` moat table starts filling. **Completes the closed loop.**
**Hand-off:** P1 renders Rung-2 causal claims; the moat dataset begins compounding.

---

## Phase 6 — Scale path, open-source & honesty audit

**Goal:** future-proof the model, open the core, guarantee honesty.

**Why it matters:** the OSS core is the community wedge (and the hackathon open-source requirement); the honesty audit is what lets the product survive a hostile question; the scale path shows the model isn't permanently stuck at small-N.

**Depends on:** P4·4, P4·5.

**Detailed tasks:**
1. **Hierarchical-model graduation** path: document/stub the mixed-effects model (company + category + engine random effects, partial pooling) for the **~15+ category / 300+ company** threshold — and note its tension (partial pooling shrinks per-category specificity; needs enough clusters to identify variance).
2. **Open-source** the measurement + experiment **methodology core** (Python package) on public GitHub; keep the **interventional dataset, vertical packs, and orchestration proprietary** (the moat is the data + loop, not the algorithm).
3. **Honesty audit:** verify across the whole product that *measurement ≠ hypothesis ≠ causal*; that no claim exceeds its data's `claim_rung`; that spillover/power/effective-N caveats are present.
4. Note the **deferred** Browserbase/Playwright AI-Overviews path (ToS risk) as explicitly out-of-v1.

**Records:** reads the full system; produces OSS core, audit sign-off, scale roadmap.
**Gotchas:** don't open-source the interventional dataset or vertical packs (that's the moat). Make the audit adversarial — try to make the product overclaim and confirm it can't.
**Tools:** Python, GitHub.
**DoD:** OSS core is public; the honesty guardrails survive a hostile demo question; the scale path is written.
**Hand-off:** the product is defensible, open where it should be, and has a credible path beyond cold-start.
