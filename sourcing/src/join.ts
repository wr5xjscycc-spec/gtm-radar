// P3 · Phase 4 task #1: join-integrity audit (company-level context → every page).
//
// WHY THIS AUDIT EXISTS:
// The model (P4) fits on PAGE rows, but the DOMINANT citation drivers are
// COMPANY-level off-page/earned/entity signals (ORCHESTRATION §6; red-team Patch E).
// Every page must therefore INHERIT its company's offpage/firmographics/understanding,
// joined on the NORMALIZED domain (docs/CONTRACT.md global rule). The danger: a
// single www/subdomain mismatch makes a page's company_domain miss its company —
// silently stripping the dominant off-page signal from EVERY page of that company.
// That is the single worst failure mode in this lane.
//
// So this join is AUDITED, not trusted:
//  - Both sides of the key are DEFENSIVELY re-normalized (the whole point is to
//    catch a key that ISN'T already normalized, even though producers normalize).
//  - A page whose company can't be found is EMITTED as an orphan (company_found=false)
//    and recorded in report.orphan_pages — never silently dropped (coverage honesty:
//    "never drop low-coverage rows silently").
//  - Companies that received zero pages are surfaced in report.childless_companies.
//
// NOTE on normalizeDomain's reach (src/domain.ts): the placeholder strips only
// `www`, NOT arbitrary subdomains (correct subdomain stripping needs a public-suffix
// list P1 owns). So `blog.example.com` does NOT normalize to `example.com` and will
// realistically ORPHAN against a company keyed `example.com`. That is EXACTLY the
// silent-drop risk this audit surfaces rather than hides.

import type {
  Company,
  Page,
  JoinedPage,
  JoinReport,
  Firmographics,
  OffPage,
  Understanding,
} from "./types";
import { normalizeDomain } from "./domain";

/** Version stamp for the join strategy (normalized-domain join). */
export const JOIN_VERSION = "join/normalized-domain@v1";

/** The company-level context subset a page inherits from its company. */
export interface InheritedContext {
  firmographics?: Firmographics;
  offpage?: OffPage;
  understanding?: Understanding;
  company_coverage_flags?: string[];
}

/**
 * Extract the company-level context a page inherits. Kept deliberately small —
 * exactly the families that DOMINATE citation plus the company's coverage flags,
 * so each row carries honest coverage.
 *
 * Each family is SHALLOW-COPIED so a downstream mutation of one JoinedPage can't
 * corrupt its sibling pages or the source `company` record (the dominant off-page
 * signal must never be cross-corrupted). Nested arrays (e.g. tech_stack) are not
 * deep-copied — consumers treat inherited context as read-only (see JoinedPage).
 */
export function inheritedContext(company: Company): InheritedContext {
  return {
    firmographics: company.firmographics ? { ...company.firmographics } : undefined,
    offpage: company.offpage ? { ...company.offpage } : undefined,
    understanding: company.understanding ? { ...company.understanding } : undefined,
    company_coverage_flags: company.coverage_flags ? [...company.coverage_flags] : undefined,
  };
}

/** Re-normalize defensively; return null (don't throw) when the value is unparseable. */
function safeNormalize(value: string): string | null {
  const key = normalizeDomain(value);
  return key || null;
}

/**
 * Join every `page` to its `company` on the NORMALIZED domain, inheriting
 * company-level context. NEVER drops a page: an unmatched page is emitted with
 * company_found=false and recorded as an orphan. The join is audited so a
 * www/subdomain mismatch is SURFACED, never silent.
 */
export function joinPagesToCompanies(
  companies: Company[],
  pages: Page[],
): { joined: JoinedPage[]; report: JoinReport } {
  // Index companies by defensively-normalized domain. Two failure modes are
  // SURFACED, never silent (both would otherwise corrupt the dominant off-page
  // signal or drop a company):
  //  - unparseable domain → can't be indexed at all → unjoinable_companies.
  //  - key COLLISION (two companies normalize to the same key) → first-wins, the
  //    loser is recorded in duplicate_domains instead of silently overwriting
  //    (an overwrite would make this domain's pages inherit the WRONG company).
  const byDomain = new Map<string, Company>();
  const unjoinable_companies: string[] = [];
  const duplicate_domains: string[] = [];
  for (const company of companies) {
    const key = safeNormalize(company.domain);
    if (key === null) {
      unjoinable_companies.push(company.domain); // raw — most coverage-broken row
      continue;
    }
    if (byDomain.has(key)) {
      duplicate_domains.push(key); // collision — keep first, surface the loser
      continue;
    }
    byDomain.set(key, company);
  }

  // Track which company domains actually received a page (for childless audit).
  const matchedDomains = new Set<string>();

  const joined: JoinedPage[] = [];
  const orphan_pages: JoinReport["orphan_pages"] = [];
  let joinedCount = 0;

  for (const page of pages) {
    const key = safeNormalize(page.company_domain);

    // A page whose company_domain can't be normalized can't join → orphan.
    if (key === null) {
      orphan_pages.push({ url: page.url, company_domain: page.company_domain });
      joined.push({ page, company_domain: page.company_domain, company_found: false });
      continue;
    }

    const company = byDomain.get(key);
    if (company === undefined) {
      // The dangerous www/subdomain miss — surfaced, never dropped. Record the
      // RAW declared company_domain (consistent with the unparseable branch and
      // more diagnostic for P1 than the normalized key).
      orphan_pages.push({ url: page.url, company_domain: page.company_domain });
      joined.push({ page, company_domain: key, company_found: false });
      continue;
    }

    matchedDomains.add(key);
    joinedCount += 1;
    joined.push({
      page,
      company_domain: key,
      company_found: true,
      ...inheritedContext(company),
    });
  }

  // Companies that inherited their context to NO page — surfaced, sorted, deduped.
  const childless = new Set<string>();
  for (const key of byDomain.keys()) {
    if (!matchedDomains.has(key)) childless.add(key);
  }
  const childless_companies = [...childless].sort();

  return {
    joined,
    report: {
      joined: joinedCount,
      orphan_pages,
      childless_companies,
      duplicate_domains,
      unjoinable_companies,
    },
  };
}
