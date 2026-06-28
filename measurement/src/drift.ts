import type { RunRecord } from "./aggregate";

export interface DriftResult {
  drift_detected: boolean;
  versions_seen: string[];
  version_changed_mid_sweep: boolean;
  sweep_start_version: string | null;
  sweep_end_version: string | null;
}

/**
 * Detect mid-sweep model-version changes across a set of run records.
 *
 * If more than one distinct model_version is present, drift is flagged.
 * The caller can decide whether to split pre/post rows or discard a partial sweep.
 *
 * Surfaces the version change rather than silently mixing pre/post-update rows.
 */
export function detectDrift(runs: RunRecord[]): DriftResult {
  if (runs.length === 0) {
    return {
      drift_detected: false,
      versions_seen: [],
      version_changed_mid_sweep: false,
      sweep_start_version: null,
      sweep_end_version: null,
    };
  }

  const sorted = [...runs].sort((a, b) => a.ts - b.ts);
  const versions = [...new Set(sorted.map((r) => r.model_version))];

  return {
    drift_detected: versions.length > 1,
    versions_seen: versions,
    version_changed_mid_sweep: versions.length > 1,
    sweep_start_version: sorted[0].model_version,
    sweep_end_version: sorted[sorted.length - 1].model_version,
  };
}

/**
 * Group runs into segments where model_version is constant.
 * Each segment is a contiguous block of runs with the same version.
 */
export function segmentByVersion(runs: RunRecord[]): Array<{
  version: string;
  runs: RunRecord[];
}> {
  if (runs.length === 0) return [];

  const sorted = [...runs].sort((a, b) => a.ts - b.ts);
  const segments: Array<{ version: string; runs: RunRecord[] }> = [];
  let currentVersion = sorted[0].model_version;
  let currentSegment: RunRecord[] = [];

  for (const run of sorted) {
    if (run.model_version !== currentVersion) {
      segments.push({ version: currentVersion, runs: currentSegment });
      currentVersion = run.model_version;
      currentSegment = [];
    }
    currentSegment.push(run);
  }
  segments.push({ version: currentVersion, runs: currentSegment });

  return segments;
}
