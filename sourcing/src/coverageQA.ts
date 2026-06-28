import type { VerticalPack } from "./verticalPack";
import type { Company } from "./fiber";
import type { PageRecord } from "./content";
import { computeCoverageFlags } from "./joinIntegrity";
import { normalizeDomain } from "../../convex/lib/domain";

export interface LowCoverageItem {
  type: "missing_firmographics" | "missing_offpage" | "missing_understanding" | "stale_page" | "featureless_page" | "orphan_page";
  company_domain?: string;
  page_url?: string;
  company_name?: string;
  reason: string;
}

export interface CoverageQAReport {
  vertical: string;
  vertical_pack_version: string;
  generated_at: string;
  pack_queries_total: number;
  pack_llm_expand_ratio: number;
  pack_seed_source_breakdown: Record<string, number>;
  companies_total: number;
  pages_total: number;
  low_coverage_items: LowCoverageItem[];
  coverage_by_source: Record<string, number>;
  flags: string[];
}

export function generateCoverageQAReport(
  pack: VerticalPack,
  companies: Company[],
  pages: PageRecord[],
): CoverageQAReport {
  const lowCoverage: LowCoverageItem[] = [];
  const coverageBySource: Record<string, number> = {};
  const flags: string[] = [];

  const companiesByDomain = new Map<string, Company>();
  for (const c of companies) {
    const norm = normalizeDomain(c.domain);
    if (norm) companiesByDomain.set(norm, c);
  }

  const pagesByDomain = new Map<string, PageRecord[]>();
  for (const p of pages) {
    const norm = normalizeDomain(p.company_domain);
    if (!norm) continue;
    const existing = pagesByDomain.get(norm) || [];
    existing.push(p);
    pagesByDomain.set(norm, existing);
  }

  for (const [domain, company] of companiesByDomain) {
    const companyPages = pagesByDomain.get(domain) || [];
    const pageFlags = computeCoverageFlags(company, companyPages);

    if (!company.firmographics || Object.keys(company.firmographics).length === 0) {
      lowCoverage.push({
        type: "missing_firmographics",
        company_domain: domain,
        company_name: company.name,
        reason: `Company ${company.name} (${domain}) has no firmographics data`,
      });
    }

    if (!company.offpage) {
      lowCoverage.push({
        type: "missing_offpage",
        company_domain: domain,
        company_name: company.name,
        reason: `Company ${company.name} (${domain}) has no off-page signals`,
      });
    }

    if (!company.understanding || !company.understanding.category) {
      lowCoverage.push({
        type: "missing_understanding",
        company_domain: domain,
        company_name: company.name,
        reason: `Company ${company.name} (${domain}) has no understanding pass`,
      });
    }

    for (const page of companyPages) {
      if (page.content_features?.freshness_days !== null && page.content_features?.freshness_days !== undefined && page.content_features.freshness_days >= 180) {
        lowCoverage.push({
          type: "stale_page",
          company_domain: domain,
          company_name: company.name,
          page_url: page.url,
          reason: `Page ${page.url} last scraped ${page.content_features.freshness_days} days ago (>180 threshold)`,
        });
      }

      if (!page.content_features || !page.content_features.word_count) {
        lowCoverage.push({
          type: "featureless_page",
          company_domain: domain,
          company_name: company.name,
          page_url: page.url,
          reason: `Page ${page.url} has no content features (word_count=0)`,
        });
      }
    }

    if (companyPages.length === 0) {
      lowCoverage.push({
        type: "featureless_page",
        company_domain: domain,
        company_name: company.name,
        reason: `Company ${company.name} (${domain}) has no pages in the enrichment set`,
      });
    }
  }

  const domainsWithPages = new Set(pages.map((p) => normalizeDomain(p.company_domain)));
  for (const p of pages) {
    const norm = normalizeDomain(p.company_domain);
    if (norm && !companiesByDomain.has(norm)) {
      lowCoverage.push({
        type: "orphan_page",
        page_url: p.url,
        company_domain: p.company_domain,
        reason: `Page ${p.url} references company domain ${p.company_domain} not found in company records`,
      });
    }
  }

  coverageBySource.llm_expand = pack.llm_expand_query_count;
  coverageBySource.grounded = pack.grounded_query_count;
  for (const [source, count] of Object.entries(pack.seed_source_breakdown)) {
    coverageBySource[source] = count;
  }

  if (lowCoverage.length > 0) {
    flags.push(`low_coverage_items:${lowCoverage.length}`);
  }
  if (pack.llm_expand_ratio > 0.5) {
    flags.push(`high_llm_expand_ratio:${(pack.llm_expand_ratio * 100).toFixed(0)}%`);
  }
  if (companies.length === 0) {
    flags.push("no_companies_in_enrichment");
  }
  if (pages.length === 0) {
    flags.push("no_pages_in_enrichment");
  }

  return {
    vertical: pack.vertical,
    vertical_pack_version: pack.version,
    generated_at: new Date().toISOString(),
    pack_queries_total: pack.total_queries,
    pack_llm_expand_ratio: pack.llm_expand_ratio,
    pack_seed_source_breakdown: pack.seed_source_breakdown,
    companies_total: companies.length,
    pages_total: pages.length,
    low_coverage_items: lowCoverage,
    coverage_by_source: coverageBySource,
    flags,
  };
}
