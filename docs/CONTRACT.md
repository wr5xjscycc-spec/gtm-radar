# The Data Contract — the 9 Convex records (Phase 0, agree first)

This is the **only interface between lanes.** Every lane reads/writes these records; no lane calls another lane's code. **Agree this in Phase 0 and freeze it.** Changes require all-affected-owner sign-off (see `ORCHESTRATION.md` §4).

P1 implements these as the Convex schema in `convex/`. This document is the human-readable source of truth; described in prose/tables (the typed schema lives in code).

## Global rules

- **Keys are normalized domains/URLs.** Lowercase, strip `www`, strip subdomain where appropriate, resolve redirects. P1 owns the single normalization helper; every lane uses it. *(A non-normalized key is the #1 silent-failure mode — joins break invisibly.)*
- **Three epistemic layers, never blurred:** `measurement` = descriptive truth · `model_fit` = hypotheses with uncertainty · `lift_result` = causal claims. The UI renders each at its own confidence; causal language is impossible without a `lift_result`.
- **Everything derived is versioned.** Carry `model_version` / `extractor_version` / `prior_version` so a mid-run change is detectable and reproducible.
- **Scope every record to a `workspace`/`customer`.**

## Records

### 1. customer / workspace  *(owner: P1)*
`id · name · vertical · own_domain · competitor_domains[] · query_pack_id · owner`

### 2. company  *(owner: P3; key: normalized domain)*
`domain(PK) · name · role(customer|competitor|battlefield) · firmographics{size, funding_stage, headcount_growth, hiring_velocity, tech_stack} · offpage{thirdparty_mentions, reddit_presence, g2_presence, wikipedia_presence, review_site_presence, brand_search_volume, backlink_density, entity_cooccurrence} · understanding{category, icp, positioning} · coverage_flags · source_versions`

### 3. page  *(owner: P3; key: company_domain + normalized url)*
`company_domain(FK) · url · role(candidate|customer|competitor) · content_features{schema_markup, comparison_table, word_count, heading_structure, freshness_days, query_term_coverage, direct_answer_first, stats_density, citation_density, quote_density, listicle_vs_prose} · extractor_version · scraped_at · cache_key`

### 4. query  *(owner: P3)*
`id · customer_id · vertical · text · seed_source(paa|keyword|reddit|analytics|llm_expand) · target_engines[]`

### 5. measurement  *(owner: P2)*
`id · query_id · page_url · engine(openai|perplexity|gemini) · model_version · run_idx · appeared(bool) · cited(bool) · position(int|null) · source_urls[] · ts · window_tag(baseline|post|adhoc) · experiment_id?`
**Aggregates** (per query×page×engine over K runs): `P_cited · ci_low · ci_high · position_weight`

### 6. model_fit  *(owner: P4)*
`id · customer_id · category · engine · coefficients[{feature, posterior_median, ci_low, ci_high, noise_flag}] · prior_version · top_hypotheses[] · n_companies(effective N) · n_rows`

### 7. experiment  *(owner: P4 design, P1 console)*
`id · customer_id · pairs[{treatment_page, control_page, match_covars}] · baseline_window · post_window · status(designing|awaiting_publish|running|complete|expired) · publish_event_ts?`

### 8. lift_result  *(owner: P4)*
`id · experiment_id · estimate · ci_low · ci_high · p_value · verdict(worked|no_effect|inconclusive) · claim_rung · computed_at`

### 9. intervention — the moat store  *(owner: P4)*
`id · feature_changed · category · engine · measured_lift · ci_low · ci_high · experiment_id · recorded_at`

## Who reads what (the join map)

| Record | Written by | Read by |
|---|---|---|
| customer/workspace | P1 | P3 (queries), P4 (fits) |
| company | P3 | P2 (who-cited mapping), P4 (context features) |
| page | P3 | P2 (candidate/loser pool), P4 (page features) |
| query | P3 | P2 (dispatch) |
| measurement | P2 | P1 (board), P4 (rows) |
| model_fit | P4 | P1 (diagnosis UI) |
| experiment | P4/P1 | P2 (re-measure), P1 (console) |
| lift_result | P4 | P1 (Rung-2 causal UI) |
| intervention | P4 | P4 (next-cycle priors), P1 (moat view) |

## Fixtures

Phase 0 ships a small set of **seed fixtures** for every record type under `tests/integration/fixtures/` so each lane can develop and test without waiting on upstream lanes. If you depend on a record another lane hasn't produced yet, code against its fixture and note the assumption in your PR.
