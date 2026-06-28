/**
 * The Convex schema — the code form of docs/CONTRACT.md (owner: P1).
 *
 * This is the single cross-lane interface. The 9 record types; three epistemic
 * layers that are NEVER blurred (measurement = descriptive truth · model_fit =
 * hypotheses with uncertainty · lift_result = causal claims). Changing a record
 * shape requires all-affected-owner sign-off (ORCHESTRATION.md §4).
 *
 * Invariants baked in here:
 *  - Every record is scoped to a `workspaceId` (per-workspace data isolation).
 *  - Cross-lane joins key on NORMALIZED domain/URL strings (company.domain,
 *    page.company_domain, page.url, measurement.page_url) — produced only by
 *    ./lib/domain and enforced in ./records mutations. Indexes back those joins.
 *  - Everything derived carries a *_version / source_versions field so a mid-run
 *    model/extractor/prior change is detectable and reproducible.
 */
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const engine = v.union(
  v.literal("openai"),
  v.literal("perplexity"),
  v.literal("gemini"),
);

export default defineSchema({
  // 1. customer / workspace (owner: P1) — the scope root.
  workspaces: defineTable({
    name: v.string(),
    vertical: v.string(),
    own_domain: v.string(), // normalized
    competitor_domains: v.array(v.string()), // normalized
    query_pack_id: v.optional(v.string()),
    owner: v.optional(v.string()), // auth subject; optional pre-auth
  }).index("by_owner", ["owner"]),

  // 2. company (owner: P3; key: normalized domain).
  companies: defineTable({
    workspaceId: v.id("workspaces"),
    domain: v.string(), // PK (normalized) — the cross-lane join key
    name: v.optional(v.string()),
    role: v.union(
      v.literal("customer"),
      v.literal("competitor"),
      v.literal("battlefield"),
    ),
    firmographics: v.optional(
      v.object({
        size: v.optional(v.string()),
        funding_stage: v.optional(v.string()),
        headcount_growth: v.optional(v.number()),
        hiring_velocity: v.optional(v.number()),
        tech_stack: v.optional(v.array(v.string())),
      }),
    ),
    offpage: v.optional(
      v.object({
        thirdparty_mentions: v.optional(v.number()),
        reddit_presence: v.optional(v.number()),
        g2_presence: v.optional(v.number()),
        wikipedia_presence: v.optional(v.number()),
        review_site_presence: v.optional(v.number()),
        brand_search_volume: v.optional(v.number()),
        backlink_density: v.optional(v.number()),
        entity_cooccurrence: v.optional(v.number()),
      }),
    ),
    understanding: v.optional(
      v.object({
        category: v.optional(v.string()),
        icp: v.optional(v.string()),
        positioning: v.optional(v.string()),
        what_you_are: v.optional(v.string()),
      }),
    ),
    coverage_flags: v.optional(v.array(v.string())),
    source_versions: v.optional(v.record(v.string(), v.string())), // reproducibility
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_workspace_role", ["workspaceId", "role"])
    .index("by_domain", ["domain"]),

  // 3. page (owner: P3; key: company_domain + normalized url).
  pages: defineTable({
    workspaceId: v.id("workspaces"),
    company_domain: v.string(), // FK (normalized) -> companies.domain
    url: v.string(), // normalized — the page join key
    role: v.union(
      v.literal("candidate"),
      v.literal("customer"),
      v.literal("competitor"),
    ),
    content_features: v.optional(
      v.object({
        schema_markup: v.optional(v.boolean()),
        comparison_table: v.optional(v.boolean()),
        word_count: v.optional(v.number()),
        heading_structure: v.optional(v.number()),
        freshness_days: v.optional(v.number()),
        query_term_coverage: v.optional(v.number()),
        direct_answer_first: v.optional(v.boolean()),
        stats_density: v.optional(v.number()),
        citation_density: v.optional(v.number()),
        quote_density: v.optional(v.number()),
        listicle_vs_prose: v.optional(v.number()),
      }),
    ),
    extractor_version: v.string(), // reproducibility
    scraped_at: v.optional(v.number()),
    cache_key: v.optional(v.string()),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_company", ["company_domain"])
    .index("by_url", ["url"]),

  // 4. query (owner: P3).
  queries: defineTable({
    workspaceId: v.id("workspaces"),
    customer_id: v.id("workspaces"),
    vertical: v.string(),
    text: v.string(),
    seed_source: v.union(
      v.literal("paa"),
      v.literal("keyword"),
      v.literal("reddit"),
      v.literal("analytics"),
      v.literal("llm_expand"),
    ),
    target_engines: v.array(engine),
  }).index("by_workspace", ["workspaceId"]),

  // 5. measurement (owner: P2) — DESCRIPTIVE TRUTH. One row per run; aggregates
  // (P_cited + CI) are stored optionally once K runs are reduced.
  measurements: defineTable({
    workspaceId: v.id("workspaces"),
    query_id: v.id("queries"),
    page_url: v.string(), // normalized -> pages.url
    engine,
    model_version: v.string(), // reproducibility / drift detection
    run_idx: v.number(),
    appeared: v.boolean(),
    cited: v.boolean(),
    position: v.union(v.number(), v.null()),
    source_urls: v.array(v.string()), // normalized
    ts: v.number(),
    window_tag: v.union(
      v.literal("baseline"),
      v.literal("post"),
      v.literal("adhoc"),
    ),
    experiment_id: v.optional(v.id("experiments")),
    // Aggregates over K runs (per query×page×engine) — present on the rolled-up row.
    P_cited: v.optional(v.number()),
    ci_low: v.optional(v.number()),
    ci_high: v.optional(v.number()),
    position_weight: v.optional(v.number()),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_query", ["query_id"])
    .index("by_workspace_engine", ["workspaceId", "engine"])
    .index("by_experiment", ["experiment_id"]),

  // 6. model_fit (owner: P4) — HYPOTHESES WITH UNCERTAINTY (never causal).
  model_fits: defineTable({
    workspaceId: v.id("workspaces"),
    customer_id: v.id("workspaces"),
    category: v.string(),
    engine,
    coefficients: v.array(
      v.object({
        feature: v.string(),
        posterior_median: v.number(),
        ci_low: v.number(),
        ci_high: v.number(),
        noise_flag: v.boolean(), // CI crosses zero -> not distinguishable from noise
      }),
    ),
    prior_version: v.string(), // reproducibility
    top_hypotheses: v.array(v.string()),
    n_companies: v.number(), // effective N (pseudo-replication guard)
    n_rows: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_customer", ["customer_id"]),

  // 7. experiment (owner: P4 design, P1 console).
  experiments: defineTable({
    workspaceId: v.id("workspaces"),
    customer_id: v.id("workspaces"),
    pairs: v.array(
      v.object({
        treatment_page: v.string(), // normalized url
        control_page: v.string(), // normalized url (hidden from customer in UI)
        match_covars: v.optional(v.record(v.string(), v.number())),
      }),
    ),
    baseline_window: v.optional(v.string()),
    post_window: v.optional(v.string()),
    // The single feature the treatment arm changed (e.g. "comparison_table") and
    // the category it sits in — set at design time, carried straight onto the
    // `intervention` moat row when the lift resolves. Optional: pre-design and
    // hand-seeded experiments may omit them.
    feature_changed: v.optional(v.string()),
    category: v.optional(v.string()),
    status: v.union(
      v.literal("designing"),
      v.literal("awaiting_publish"),
      v.literal("running"),
      v.literal("complete"),
      v.literal("expired"),
    ),
    publish_event_ts: v.optional(v.number()),
    awaiting_since: v.optional(v.number()), // P1 ops: when the publish slot started (14-day expiry)
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_status", ["status"]),

  // 8. lift_result (owner: P4) — CAUSAL CLAIMS (the ONLY record that licenses
  // causal language in the UI; see the claim-ladder guard).
  lift_results: defineTable({
    workspaceId: v.id("workspaces"),
    experiment_id: v.id("experiments"),
    estimate: v.number(),
    ci_low: v.number(),
    ci_high: v.number(),
    p_value: v.number(),
    verdict: v.union(
      v.literal("worked"),
      v.literal("no_effect"),
      v.literal("inconclusive"),
    ),
    claim_rung: v.number(),
    computed_at: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_experiment", ["experiment_id"]),

  // run_records (owner: P1, Phase 6) — observability: per-cycle spend + calls +
  // per-engine error rates. P2 writes these; P1's ops view renders them.
  run_records: defineTable({
    workspaceId: v.id("workspaces"),
    cycle_id: v.string(),
    queries_issued: v.number(),
    calls_made: v.number(),
    spend_usd: v.number(),
    per_engine: v.record(
      v.string(),
      v.object({ calls: v.number(), errors: v.number() }),
    ),
    ts: v.number(),
  }).index("by_workspace", ["workspaceId"]),

  // +1. analysis_jobs (owner: P2/P4) — round-trip tracking for Convex → Python fit jobs.
  analysis_jobs: defineTable({
    workspaceId: v.id("workspaces"),
    customer_id: v.string(),
    category: v.string(),
    engine,
    request: v.string(), // JSON-serialized FitRequest
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("complete"),
      v.literal("failed"),
    ),
    job_id: v.string(), // Python service's job_id
    result: v.optional(v.string()), // JSON-serialized ModelFit
    error: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_job_id", ["job_id"]),

  // 9. intervention (owner: P4) — the moat store.
  interventions: defineTable({
    workspaceId: v.id("workspaces"),
    feature_changed: v.string(),
    category: v.string(),
    engine,
    measured_lift: v.number(),
    ci_low: v.number(),
    ci_high: v.number(),
    experiment_id: v.id("experiments"),
    recorded_at: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_category", ["category"]),
});
