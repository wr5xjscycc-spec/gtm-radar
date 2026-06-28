import { normalizeDomain } from "../../convex/lib/domain";
import type { Company } from "./fiber";
import type { PageRecord } from "./content";

export interface InheritedPageRow {
  page_url: string;
  company_domain: string;
  page_features: Record<string, unknown>;
  company_name: string;
  company_role: string;
  firmographics: Company["firmographics"] | null;
  offpage: Company["offpage"] | null;
  understanding: Company["understanding"] | null;
  coverage_flags: string[];
}

export interface JoinAuditResult {
  joined: InheritedPageRow[];
  orphan_pages: Array<{ url: string; company_domain: string }>;
  coverage_flags_summary: Record<string, number>;
}

const FRESHNESS_DAYS_THRESHOLD = 180;

export function computeCoverageFlags(
  company: Company,
  pages: PageRecord[]
): string[] {
  const flags: string[] = [];

  if (!company.firmographics || Object.keys(company.firmographics).length === 0) {
    flags.push("missing_firmographics");
  }
  if (!company.offpage) {
    flags.push("missing_offpage_signals");
  } else {
    const offpageKeys = Object.keys(company.offpage) as (keyof NonNullable<Company["offpage"]>)[];
    const zeroKeys = offpageKeys.filter((k) => {
      const v = company.offpage![k];
      return v === undefined || v === 0;
    });
    if (zeroKeys.length >= offpageKeys.length * 0.75) {
      flags.push("low_offpage_coverage");
    }
  }
  if (!company.understanding || !company.understanding.category) {
    flags.push("missing_understanding");
  }

  const stalePages = pages.filter((p) => {
    if (!p.content_features?.freshness_days) return false;
    return p.content_features.freshness_days >= FRESHNESS_DAYS_THRESHOLD;
  });
  if (stalePages.length > 0) {
    flags.push(`stale_pages:${stalePages.length}`);
  }

  const featurelessPages = pages.filter((p) => {
    if (!p.content_features) return true;
    return !p.content_features.word_count;
  });
  if (featurelessPages.length > 0) {
    flags.push(`featureless_pages:${featurelessPages.length}`);
  }

  return flags;
}

export function joinCompanyToPages(
  company: Company,
  pages: PageRecord[]
): JoinAuditResult {
  const joined: InheritedPageRow[] = [];
  const orphan_pages: Array<{ url: string; company_domain: string }> = [];
  const normDomain = normalizeDomain(company.domain);

  const coverage_flags: string[] = [];
  const coverageStack = [...(company.coverage_flags ?? [])];

  for (const page of pages) {
    const pageNorm = normalizeDomain(page.company_domain);
    if (pageNorm !== normDomain) {
      orphan_pages.push({ url: page.url, company_domain: page.company_domain });
      continue;
    }

    const pageFlags = [...coverageStack];
    if (!page.content_features) {
      pageFlags.push("missing_content_features");
    } else {
      if (page.content_features.word_count === 0) {
        pageFlags.push("zero_word_count");
      }
      if (page.content_features.freshness_days !== null && page.content_features.freshness_days >= FRESHNESS_DAYS_THRESHOLD) {
        pageFlags.push("stale_page");
      }
    }

    joined.push({
      page_url: page.url,
      company_domain: company.domain,
      page_features: page.content_features,
      company_name: company.name,
      company_role: company.role,
      firmographics: company.firmographics ?? null,
      offpage: company.offpage ?? null,
      understanding: company.understanding ?? null,
      coverage_flags: pageFlags,
    });
  }

  return {
    joined,
    orphan_pages,
    coverage_flags_summary: {},
  };
}

export function joinAllCompaniesToPages(
  companies: Company[],
  pages: PageRecord[]
): JoinAuditResult {
  let allJoined: InheritedPageRow[] = [];
  let allOrphans: Array<{ url: string; company_domain: string }> = [];
  const flagCounts: Record<string, number> = {};

  for (const company of companies) {
    const companyPages = pages.filter((p) => {
      return normalizeDomain(p.company_domain) === normalizeDomain(company.domain);
    });
    const result = joinCompanyToPages(company, companyPages.length > 0 ? companyPages : pages);
    allJoined = allJoined.concat(result.joined);
    allOrphans = allOrphans.concat(result.orphan_pages);

    const companyFlags = computeCoverageFlags(company, companyPages);
    for (const f of companyFlags) {
      flagCounts[f] = (flagCounts[f] || 0) + 1;
    }

    for (const row of result.joined) {
      for (const f of row.coverage_flags) {
        flagCounts[f] = (flagCounts[f] || 0) + 1;
      }
    }
  }

  return {
    joined: allJoined,
    orphan_pages: allOrphans,
    coverage_flags_summary: flagCounts,
  };
}
