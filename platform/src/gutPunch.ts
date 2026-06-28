/**
 * Gut-punch board formatters (owner: P1, Phase 3).
 *
 * The demo's emotional core: "you 0/12 · competitor 9/12 · cited from these
 * sources." Always per-engine; always show P_cited as a RATE WITH UNCERTAINTY
 * (a CI), never a bare binary — a red-team point is that non-determinism makes
 * single draws unreliable. Pure + unit-tested; the React board renders over these.
 */

export interface Side {
  cited: number;
  total: number;
}

/** "0 / 12" style score. */
export function score(s: Side): string {
  return `${s.cited} / ${s.total}`;
}

/** Headline string for one engine. */
export function headline(
  you: Side,
  topCompetitor: { domain: string; cited: number; total: number } | null,
): string {
  const me = `you ${score(you)}`;
  if (!topCompetitor) return me;
  return `${me} · top competitor ${topCompetitor.domain} ${topCompetitor.cited}/${topCompetitor.total}`;
}

/**
 * P_cited rendered as a rate with its CI: "33% (CI 12–61%)". Falls back to the
 * raw fraction when no CI/aggregate is present. Uncertainty is always visible.
 */
export function formatPcitedCI(
  p?: number | null,
  ciLow?: number | null,
  ciHigh?: number | null,
): string {
  if (typeof p !== "number") return "—";
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  if (typeof ciLow === "number" && typeof ciHigh === "number") {
    return `${pct(p)} (CI ${pct(ciLow)}–${pct(ciHigh)})`;
  }
  return pct(p);
}

/** Measurement sweep progress for the live status line. */
export function measurementProgress(
  measurements: { cited?: boolean }[],
  expectedTotal?: number,
): { done: number; total: number; pct: number } {
  const done = measurements.length;
  const total = Math.max(expectedTotal ?? done, done);
  return { done, total, pct: total === 0 ? 0 : Math.round((done / total) * 100) };
}
