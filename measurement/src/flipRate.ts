import type { RunRecord } from "./aggregate";
import { normalizeUrl } from "../../convex/lib/domain";

export interface PageFlipRate {
  flip_rate: number;
  total_pairs: number;
  flipped_pairs: number;
}

export interface FlipRateResult {
  overall_flip_rate: number;
  per_page: Record<string, PageFlipRate>;
  total_pairs: number;
  flipped_pairs: number;
}

/**
 * Compute label flip rate across repeated runs of the same (query, page).
 *
 * Groups runs by (query_id, normalized page_url), then examines every
 * pair of runs (i < j) within each group. A "flip" occurs when the
 * winner/loser label differs between the two runs.
 *
 * The flip rate is the honest non-determinism disclosure: how often
 * re-running the same query gives a different winner/loser label.
 */
export function computeFlipRate(runs: RunRecord[]): FlipRateResult {
  const groups = new Map<string, RunRecord[]>();

  for (const run of runs) {
    const key = `${run.query_id}::${normalizeUrl(run.page_url)}`;
    const group = groups.get(key) ?? [];
    group.push(run);
    groups.set(key, group);
  }

  let totalPairs = 0;
  let flippedPairs = 0;
  const perPage: Record<string, PageFlipRate> = {};

  for (const [key, group] of groups) {
    let pageTotal = 0;
    let pageFlipped = 0;

    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        pageTotal++;
        const labelI = group[i].cited ? "winner" : "loser";
        const labelJ = group[j].cited ? "winner" : "loser";
        if (labelI !== labelJ) {
          pageFlipped++;
        }
      }
    }

    totalPairs += pageTotal;
    flippedPairs += pageFlipped;

    perPage[key] = {
      flip_rate: pageTotal > 0 ? pageFlipped / pageTotal : 0,
      total_pairs: pageTotal,
      flipped_pairs: pageFlipped,
    };
  }

  return {
    overall_flip_rate: totalPairs > 0 ? flippedPairs / totalPairs : 0,
    per_page: perPage,
    total_pairs: totalPairs,
    flipped_pairs: flippedPairs,
  };
}
