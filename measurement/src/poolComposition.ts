import type { CandidatePoolItem } from "./label";
import { normalizeDomain } from "../../convex/lib/domain";

export interface CompanyShare {
  company_domain: string;
  count: number;
  percentage: number;
}

export interface PoolCompositionResult {
  total_pages: number;
  companies: CompanyShare[];
  degenerate_pool: boolean;
  dominant_company: string | null;
  dominant_percentage: number;
  threshold: number;
}

/**
 * Check a category's case-control pool for pseudo-replication.
 *
 * Flags a degenerate_pool warning if one company's pages exceed the
 * threshold percentage (default 50%) of the total candidate pool.
 * Pseudo-replication (one company dominating) would bias the model.
 */
export function checkPoolComposition(
  pool: CandidatePoolItem[],
  threshold: number = 0.5,
): PoolCompositionResult {
  const domainCounts = new Map<string, number>();

  for (const item of pool) {
    const nd = normalizeDomain(item.company_domain);
    domainCounts.set(nd, (domainCounts.get(nd) ?? 0) + 1);
  }

  const total = pool.length;
  const companies: CompanyShare[] = [];

  let maxCount = 0;
  let maxDomain: string | null = null;

  for (const [company_domain, count] of domainCounts) {
    const percentage = total > 0 ? count / total : 0;
    companies.push({ company_domain, count, percentage });

    if (count > maxCount) {
      maxCount = count;
      maxDomain = company_domain;
    }
  }

  companies.sort((a, b) => b.count - a.count);

  const dominant_percentage = total > 0 ? maxCount / total : 0;

  return {
    total_pages: total,
    companies,
    degenerate_pool: dominant_percentage > threshold,
    dominant_company: maxDomain,
    dominant_percentage,
    threshold,
  };
}
