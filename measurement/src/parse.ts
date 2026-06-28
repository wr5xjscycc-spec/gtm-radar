import { normalizeDomain } from "../../convex/lib/domain";

export interface CitationRecord {
  source_url: string;
  normalized_domain: string;
  matched_company_domain?: string;
  matched_page_url?: string;
}

export interface CitationParseResult {
  citations: CitationRecord[];
  cited_domains: string[];
}

export interface KnownPage {
  company_domain: string;
  url: string;
}

export interface KnownCompany {
  domain: string;
}

export function parseCitations(
  sourceUrls: string[],
  knownPages: KnownPage[],
  knownCompanies: KnownCompany[],
): CitationParseResult {
  const companyDomainSet = new Set(knownCompanies.map((c) => normalizeDomain(c.domain)));
  const pageMap = new Map<string, string>();
  for (const p of knownPages) {
    pageMap.set(normalizeDomain(p.url), p.company_domain);
  }

  const citations: CitationRecord[] = [];
  const citedDomainsSet = new Set<string>();

  for (const url of sourceUrls) {
    const nd = normalizeDomain(url);
    const matchedCompany = companyDomainSet.has(nd) ? nd : undefined;
    const matchedPageUrl = pageMap.has(normalizeDomain(url)) ? url : undefined;

    citations.push({
      source_url: url,
      normalized_domain: nd,
      matched_company_domain: matchedCompany,
      matched_page_url: matchedPageUrl,
    });

    if (matchedCompany) {
      citedDomainsSet.add(nd);
    }
  }

  return { citations, cited_domains: [...citedDomainsSet] };
}
