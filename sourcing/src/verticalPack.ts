import type { QueryRecord } from "./query";

export interface CMSTarget {
  name: string;
  url: string;
  relevance: string;
  audience: string;
}

export interface VerticalPack {
  vertical: string;
  version: string;
  generated_at: string;
  queries: QueryRecord[];
  cms_targets: CMSTarget[];
  total_queries: number;
  grounded_query_count: number;
  llm_expand_query_count: number;
  llm_expand_ratio: number;
  seed_source_breakdown: Record<string, number>;
}

const VERTICAL = "GTM analytics";
const CUSTOMER_ID = "demo-customer";
const PACK_VERSION = "vertical-pack-2026.06-v1";

const CMS_TARGETS: CMSTarget[] = [
  {
    name: "G2",
    url: "https://learn.g2.com",
    relevance: "Leader in B2B software reviews — GTM analytics category pages drive high-intent traffic",
    audience: "B2B software buyers evaluating tools",
  },
  {
    name: "TrustRadius",
    url: "https://www.trustradius.com",
    relevance: "Peer-reviewed software comparisons — buyers trust real user reviews",
    audience: "Mid-market and enterprise tech buyers",
  },
  {
    name: "SaaStr",
    url: "https://www.saastr.com",
    relevance: "Top community for SaaS founders and operators — GTM analytics is a core topic",
    audience: "SaaS founders, VPs of Sales, revenue leaders",
  },
  {
    name: "HubSpot Blog",
    url: "https://blog.hubspot.com/sales",
    relevance: "Massive B2B sales/marketing readership — GTM analytics articles rank well on search",
    audience: "B2B sales and marketing professionals",
  },
  {
    name: "Product Hunt",
    url: "https://www.producthunt.com/categories/analytics",
    relevance: "Launchpad for new GTM tools — buyers discover and discuss analytics platforms",
    audience: "Early-adopter tech buyers and product builders",
  },
  {
    name: "TechCrunch",
    url: "https://techcrunch.com/category/enterprise",
    relevance: "Covers enterprise SaaS funding and product launches — signals category legitimacy",
    audience: "Tech investors, executives, and startup influencers",
  },
  {
    name: "VentureBeat",
    url: "https://venturebeat.com/category/enterprise",
    relevance: "Enterprise AI/analytics coverage — reaches senior decision-makers",
    audience: "Enterprise tech buyers and investors",
  },
  {
    name: "LinkedIn Pulse",
    url: "https://www.linkedin.com/pulse/topic/sales-analytics",
    relevance: "Professional network with built-in distribution to B2B buyers — ideal for thought leadership",
    audience: "Sales leaders, RevOps professionals, B2B executives",
  },
];

const CURATED_QUERIES: Array<{
  text: string;
  seed_source: QueryRecord["seed_source"];
}> = [
  // People Also Ask — grounded from SERP
  { text: "what is gtm analytics", seed_source: "paa" },
  { text: "what does gtm stand for in analytics", seed_source: "paa" },
  { text: "how does gtm analytics work", seed_source: "paa" },
  { text: "what is revenue intelligence software", seed_source: "paa" },
  { text: "how to measure sales pipeline velocity", seed_source: "paa" },
  // Keyword — grounded from keyword research
  { text: "best gtm analytics platform 2026", seed_source: "keyword" },
  { text: "gtm analytics tools comparison", seed_source: "keyword" },
  { text: "revenue intelligence vs crm", seed_source: "keyword" },
  { text: "b2b sales attribution models", seed_source: "keyword" },
  { text: "how to calculate cac payback period", seed_source: "keyword" },
  { text: "sales pipeline coverage ratio benchmark", seed_source: "keyword" },
  { text: "open source gtm tools", seed_source: "keyword" },
  { text: "ai for sales forecasting", seed_source: "keyword" },
  { text: "lead scoring best practices", seed_source: "keyword" },
  { text: "salesforce vs hubspot for enterprise", seed_source: "keyword" },
  // Reddit — grounded from forum mining
  { text: "best gtm analytics tools reddit", seed_source: "reddit" },
  { text: "revenue intelligence recommendations", seed_source: "reddit" },
  { text: "sales analytics stack what are you using", seed_source: "reddit" },
  { text: "gtm analytics for small business pricing", seed_source: "reddit" },
  { text: "replacing salesforce with hubspot experience", seed_source: "reddit" },
  // Analytics — grounded from customer analytics
  { text: "how to track multi-channel attribution", seed_source: "analytics" },
  { text: "b2b lead scoring models that work", seed_source: "analytics" },
  { text: "customer acquisition cost benchmarks by industry", seed_source: "analytics" },
  { text: "sales cycle length reduction strategies", seed_source: "analytics" },
  { text: "conversion rate optimization for b2b", seed_source: "analytics" },
  // LLM-expand — generated from the grounded seeds
  { text: "gtm analytics implementation guide", seed_source: "llm_expand" },
  { text: "best free gtm analytics tools", seed_source: "llm_expand" },
  { text: "how to set up revenue attribution models", seed_source: "llm_expand" },
  { text: "sales forecasting accuracy improvement techniques", seed_source: "llm_expand" },
  { text: "gtm analytics stack for early stage startups", seed_source: "llm_expand" },
  { text: "pipeline generation metrics every vp sales should track", seed_source: "llm_expand" },
  { text: "b2b saas go to market analytics framework", seed_source: "llm_expand" },
  { text: "how to choose between revenue intelligence platforms", seed_source: "llm_expand" },
];

export function buildVerticalPack(): VerticalPack {
  const queries: QueryRecord[] = CURATED_QUERIES.map((q, idx) => ({
    id: `q-${CUSTOMER_ID}-gtm-analytics-${idx}`,
    customer_id: CUSTOMER_ID,
    vertical: VERTICAL,
    text: q.text,
    seed_source: q.seed_source,
    target_engines: ["openai"],
  }));

  const breakdown: Record<string, number> = {};
  let groundedCount = 0;
  let llmExpandCount = 0;

  for (const q of queries) {
    breakdown[q.seed_source] = (breakdown[q.seed_source] || 0) + 1;
    if (q.seed_source === "llm_expand") {
      llmExpandCount++;
    } else {
      groundedCount++;
    }
  }

  const total = queries.length;

  return {
    vertical: VERTICAL,
    version: PACK_VERSION,
    generated_at: new Date().toISOString(),
    queries,
    cms_targets: CMS_TARGETS,
    total_queries: total,
    grounded_query_count: groundedCount,
    llm_expand_query_count: llmExpandCount,
    llm_expand_ratio: total > 0 ? llmExpandCount / total : 0,
    seed_source_breakdown: breakdown,
  };
}
