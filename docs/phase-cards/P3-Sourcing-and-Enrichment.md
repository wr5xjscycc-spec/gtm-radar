# P3 — Sourcing & Enrichment · Detailed Build Brief

**You own the data supply.** The battlefield builder, company-understanding pass, firmographics, content scrape + page features, off-page/entity enrichment, query seeding + generation, feature extraction, category-level caching, and the launch vertical pack. Everything the model learns from, you produce. The single most important strategic correction from the red-team lives in your lane: **off-page / earned-media / entity signals dominate AI citation — not on-page tweaks.** If you only supply page features, the model optimizes the weak lever.

> Read `GTM-Radar-Architecture.md` (§4.3, §5.3–5.6) and `GTM-Radar-redteam-and-patches.md` (Patch E, Theme E) before starting.

---

## Shared context (true for all lanes)

**The contract = the Convex record set**, joined on **normalized domain** (P1 owns the helper — always use it). The records you produce:

- **company** — domain(PK, normalized), name, role, **firmographics**{size, funding_stage, headcount_growth, hiring_velocity, tech_stack}, **offpage**{thirdparty_mentions, reddit_presence, g2_presence, wikipedia_presence, review_site_presence, brand_search_volume, backlink_density, entity_cooccurrence}, **understanding**{category, icp, positioning}, coverage_flags, source_versions.
- **page** — company_domain(FK), url(normalized), role(candidate|customer|competitor), **content_features**{schema_markup, comparison_table, word_count, heading_structure, freshness_days, query_term_coverage, direct_answer_first, stats_density, citation_density, quote_density, listicle_vs_prose}, **extractor_version**, scraped_at, cache_key.
- **query** — id, customer_id, vertical, text, **seed_source**(paa|keyword|reddit|analytics|llm_expand), target_engines[].

**The non-negotiable supply facts (from the red-team):**
1. **Off-page dominates.** Verified evidence: ~82–84% of AI citations are earned/third-party media (Muck Rack); third-party distribution gave +239% median visibility (Stacker×Scrunch); brand mentions ~3× stronger than backlinks (Ahrefs); Wikipedia/Reddit are top sources. **You must supply off-page/entity features**, or the model is blind to the real drivers. *Nuance:* on-page still matters — the GEO paper (Aggarwal, KDD 2024) shows adding statistics/citations/quotes lifts citation ~30–40% — so you supply **both** families.
2. **Don't invent queries.** LLM-only buyer questions don't match real query distributions. **Seed from real data** (SERP "People Also Ask", keyword volume, Reddit/forum mining, customer analytics), then LLM-*expand*. Tag every query's `seed_source`.
3. **Lane discipline:** Orange Slice = page/content; Fiber = company/intent/off-page. Don't double-source the same field from both.
4. **Feature extraction is noisy** — prefer deterministic parses (schema, table, word count) and treat subjective LLM-extracted features as measurement-error-laden (validate with agreement checks). Stamp `extractor_version`.
5. **Sourcing order:** battlefield first (enrichment needs domains), then content + off-page enrichment in parallel.

**Phase timeline:** 0 Foundations → 1 Battlefield → 2 **Enrich/Query/Feature (your heavy phase)** → 3 Measurement → 4 Diagnosis → 5 Experiment/Loop → 6 Ship.

---

## Testing standard (applies to every card)

No card is **Done** until its work ships with **passing automated tests in CI** (see `CONTRIBUTING.md` / `docs/TESTING.md`). Vendors (Fiber / Orange Slice / SERP / Reddit / LLM) are **mocked in unit tests** and run via **recorded fixtures** in integration tests — never live in CI. Tests land with the code.

| Phase | P3 required tests / setup |
|---|---|
| 0 | lane scaffold + **vitest** harness green in CI; Fiber-MCP smoke test (**mocked**) that writes a `company` record with a normalized domain |
| 1 | battlefield mapping tests; company-understanding output-shape test (**mocked LLM**); firmographic field-mapping tests |
| 2 | Orange Slice page-feature mapping tests (fixtures); off-page signal mapping tests; **query-gen seed-source tagging tests** (assert a healthy non-`llm_expand` ratio); **deterministic parser tests** (schema/JSON-LD, comparison-table, word-count, headings) |
| 3 | candidate-pool construction tests (classic-search-ranked set); **subjective-feature agreement-check test** (report inter-rater/LLM agreement); extractor-versioning test |
| 4 | **join-integrity tests** (off-page/company features inherit to EVERY page; no silent drops on www/subdomain mismatch); coverage-flag tests |
| 5 | cache hit/miss tests; **invalidation tests** (on `extractor_version` change + freshness window) |
| 6 | vertical-pack validation tests; coverage-QA assertions (low-coverage surfaced, not dropped) |

---

## Phase 0 — One battlefield

**Goal:** prove company sourcing through Fiber.

**Why it matters:** the battlefield (population of potential winners) is the foundation of every later row. Fiber is a $500-credit sponsor tool and the largest credit pool — de-risk the MCP integration immediately.

**Depends on:** P1·0 (schema, domain helper).

**Detailed tasks:**
1. Wire **Fiber** via **MCP**; call `find-similar-companies` for one test customer.
2. Write `company` records (role=battlefield) keyed on **normalized domain**.

**Records:** reads seed `customer`/competitors; writes `company`.
**Gotchas:** normalize every domain on write (or P2/P4 joins fail). Confirm Fiber returns real, current companies in the right category — garbage battlefield → garbage everything.
**Tools:** Fiber (MCP).
**DoD:** a real test company yields a populated battlefield on P1's board.
**Hand-off:** P4 can start row-assembly fixtures; P1 shows the battlefield filling.

---

## Phase 1 — Full battlefield, understanding & firmographics

**Goal:** the complete company layer — who's in the category, what the customer is, and the context features.

**Why it matters:** PRD Stages 2–4 setup. The "what you are" card (rendered by P1) builds demo trust; firmographics are the context-feature family (kept small so it doesn't dominate the model — a red-team requirement, since context features are company-level and have small effective N).

**Depends on:** P3·0.

**Detailed tasks:**
1. **Battlefield builder**: expand to **20–40 real category companies**. Tag roles (customer / competitor / battlefield).
2. **Company-understanding** pass: gpt-4o-mini over the scraped site → `understanding{category, icp, positioning}` + the 4-line "what you are" text.
3. **Firmographics/context** via Fiber: size, funding_stage, headcount_growth, hiring_velocity, tech_stack → `company.firmographics`.

**Records:** writes `company.understanding`, `company.firmographics`.
**Gotchas:** keep the context-feature family small and clearly company-level — the model treats these as cluster-level (effective N = #companies, ~20–40), so don't over-expand them. Make the understanding pass cheap (gpt-4o-mini), not a big report.
**Tools:** Fiber, gpt-4o-mini.
**DoD:** every battlefield company has firmographics; the customer has an accurate "what you are" card.
**Hand-off:** P1 renders the card; P4 has context features; P3 can now enrich pages.

---

## Phase 2 — Content + off-page enrichment, queries & features  *(heavy phase)*

**Goal:** produce everything the model consumes — both feature families, plus the grounded query set.

**Why it matters:** this is the lane's core and where the strategic patch lands. Get the off-page signals and grounded queries right and the model can find real drivers; skip them and you've rebuilt the weak-lever product the red-team killed.

**Depends on:** P3·1.

**Detailed tasks:**
1. **Content enrichment (Orange Slice):** scrape candidate pages per company → `page` records + `content_features`. Orange Slice = page/content only.
2. **Off-page / entity enrichment (Fiber + SERP + Reddit):** populate `company.offpage` — third-party/earned-media mention counts, **Reddit / G2 / Wikipedia / review-site presence**, brand-search volume, backlink/entity co-occurrence. These are the dominant citation drivers; treat them as first-class.
3. **Query generation:** seed from **SERP "People Also Ask"** + keyword volume (DataForSEO/SerpAPI), **Reddit/forum mining**, and the customer's analytics → then **LLM-expand**. Produce 300–500 grounded queries; tag each `seed_source`; assemble them into the **vertical query pack**.
4. **Feature extraction:** deterministic parsers for objective `content_features` (schema/JSON-LD present, comparison_table present, word_count, heading_structure, freshness_days, query_term_coverage); **gpt-4o-mini** for subjective ones (direct_answer_first, stats_density, citation_density, quote_density — the GEO-paper tactics). Stamp `extractor_version`.

**Records:** writes `page` + `content_features`, `company.offpage`, `query` (with seed_source).
**Gotchas:** don't let `llm_expand` dominate the query set — keep a healthy ratio of real-seeded queries (P1 surfaces this ratio). Don't double-source a field from both Fiber and Orange Slice. Prefer deterministic parses; subjective features will be validated in Phase 3.
**Tools:** Orange Slice, Fiber, DataForSEO/SerpAPI, Reddit API, gpt-4o-mini, parsers.
**DoD:** every company has off-page signals; every page has a full feature vector; the query set is grounded and vertical-specific.
**Hand-off:** P2 can measure the grounded queries; P4 has both feature families.

---

## Phase 3 — Candidate pool & extractor hardening

**Goal:** make P2's labels and P4's features trustworthy.

**Why it matters:** the case-control candidate pool is a statistical-correctness requirement (it's how the "loser" label avoids selection bias). And subjective features need a measured agreement number so the model's honesty story holds.

**Depends on:** P3·2; coordinates with P2·2 (labeling) and P4 (features).

**Detailed tasks:**
1. **Candidate pool sourcing:** for each query, get the pages that **rank in classic search** (via SERP) = the "could-have-been-cited" set. This is the loser pool P2 labels against (cited→winner, in-pool-but-not-cited→loser).
2. **Extractor hardening:** add **inter-rater / LLM-agreement spot-checks** on a labeled subset for the subjective features; record the agreement number (honest measurement-error disclosure). Version the extractor.

**Records:** reads `query`, `page`; writes candidate-pool table, validated features + agreement metrics.
**Gotchas:** a principled candidate pool is the difference between a defensible model and a biased one — don't shortcut it to "all uncited pages." Report the agreement number even if it's mediocre.
**Tools:** DataForSEO/SerpAPI, gpt-4o-mini, parsers.
**DoD:** P2 has a principled loser pool; subjective features carry a measured agreement number.
**Hand-off:** P2·2/P2·3 label correctly; P4 fits on validated features.

---

## Phase 4 — Join integrity for the model

**Goal:** guarantee the model gets correctly-joined, coverage-honest context.

**Why it matters:** company-level off-page/context features must attach to every page row from that company (inheritance) — and silent join misses (domain mismatches) would drop the dominant signals. Coverage must be visible, not hidden (a red-team transparency requirement).

**Depends on:** P3·2, P3·3.

**Detailed tasks:**
1. Verify **off-page/company features join on normalized domain** to every `page` row; spot-check that no company's pages are missing inherited context.
2. **Coverage flags:** compute and write `coverage_flags` for low-coverage companies/pages; ensure P1 surfaces them rather than silently dropping rows.

**Records:** reads `company`, `page`, features; writes `coverage_flags`, clean joined feature set.
**Gotchas:** a single www/subdomain mismatch can silently strip a company's off-page signals from all its pages — audit the join. Never drop low-coverage rows silently; flag them.
**Tools:** Convex, parsers.
**DoD:** P4 receives complete, correctly-joined feature vectors with coverage transparency.
**Hand-off:** P4·3/P4·4 fit on clean inputs.

---

## Phase 5 — Category-level caching (cost lever)

**Goal:** cut per-customer cost by reusing shared category data.

**Why it matters:** the #1 surviving risk is unit economics. Battlefield competitors overlap heavily across customers in the same vertical — caching their scrapes/features is a major cost lever (alongside P2's adaptive sampling).

**Depends on:** P3·2.

**Detailed tasks:**
1. **Category-level page/extraction caching**: key on `cache_key` (normalized domain + content hash + extractor_version); reuse competitor scrapes/features across customers in the same vertical.
2. **Cache invalidation** tied to a freshness window (so stale features don't poison fits).

**Records:** reads/writes `page` + features via the shared cache.
**Gotchas:** invalidate on staleness and on `extractor_version` change — a cached feature from an old extractor must not silently mix with new ones.
**Tools:** Convex.
**DoD:** a second customer in the same vertical reuses cached competitor data; measured cost drop.
**Hand-off:** P2/P4 cycles get cheaper; unit economics improve.

---

## Phase 6 — Vertical pack finalization & coverage QA

**Goal:** make the launch vertical real and honest.

**Why it matters:** the wedge is **vertical-first**. The launch vertical's curated query pack + relevant CMS targets are what make the product feel sharp and affordable in one category instead of mediocre everywhere.

**Depends on:** P3·2–P3·5; coordinates with P4 (CMS targets) and P1 (coverage UI).

**Detailed tasks:**
1. Finalize the **one launch vertical**: curated, validated query pack; the CMS targets relevant to that vertical (handed to P4 for one-click publish).
2. **Coverage QA**: sweep enrichment for the vertical; ensure low-coverage is flagged in the UI (with P1), not hidden.

**Records:** reads all supply records; writes the production vertical pack + final coverage_flags.
**Gotchas:** resist the urge to go horizontal — depth in one vertical beats shallow coverage everywhere (red-team: positioning trap). Be honest about coverage gaps.
**Tools:** Fiber, Orange Slice, SERP/Reddit.
**DoD:** the launch vertical is fully wired, curated, and transparent about its gaps.
**Hand-off:** the product has a credible, honest launch surface.
