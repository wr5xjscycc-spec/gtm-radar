/**
 * Experiment compliance & scheduling logic (owner: P1, Phase 5).
 *
 * The moat only compounds if customers actually SHIP the asset and the system
 * re-measures. Red-team flagged compliance as the single biggest threat to the
 * moat — these are the mitigations:
 *   - controls stay invisible to the customer (Hawthorne)
 *   - an experiment cannot enter "running" until a publish event (awaiting-publish gate)
 *   - unpublished slots auto-expire at 14 days (free the credits)
 *   - cadence is monthly baseline + event-driven post ONLY (never weekly multi-engine — cost)
 *
 * Pure + unit-tested; Convex mutations/crons enforce these at the data layer.
 */

export type ExperimentStatus =
  | "designing"
  | "awaiting_publish"
  | "running"
  | "complete"
  | "expired";

const ALLOWED: Record<ExperimentStatus, ExperimentStatus[]> = {
  designing: ["awaiting_publish"],
  awaiting_publish: ["running", "expired"],
  running: ["complete"],
  complete: [],
  expired: [],
};

/**
 * Status-transition gate. Entering "running" REQUIRES a publish event — an
 * experiment can't be "running" while the treatment is unpublished (the DiD
 * would be measuring nothing).
 */
export function canTransition(
  from: ExperimentStatus,
  to: ExperimentStatus,
  ctx: { hasPublishEvent: boolean },
): boolean {
  if (!ALLOWED[from]?.includes(to)) return false;
  if (to === "running" && !ctx.hasPublishEvent) return false;
  return true;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A slot awaiting publication expires after `days` (default 14) — frees credits. */
export function slotExpired(awaitingSince: number, now: number, days = 14): boolean {
  if (typeof days !== "number" || !Number.isFinite(days) || days < 0) return false;
  return now - awaitingSince >= days * DAY_MS;
}

/**
 * Cadence guard (cost). Allowed: monthly (≥28d) baseline; event-driven post is
 * separate. BANNED: weekly (≤7d) multi-engine sweeps — that breaks unit economics.
 */
export function isAllowedCadence(c: { everyDays: number; engines: number }): boolean {
  if (c.everyDays <= 7 && c.engines > 1) return false; // weekly multi-engine — banned
  return c.everyDays >= 28; // monthly baseline
}

/** Hawthorne mitigation: the customer-facing view NEVER exposes control_page. */
export function customerExperimentView<
  T extends { pairs: { treatment_page: string; control_page: string }[] },
>(exp: T): Omit<T, "pairs"> & { pairs: { treatment_page: string }[] } {
  return {
    ...exp,
    pairs: exp.pairs.map((p) => ({ treatment_page: p.treatment_page })),
  };
}

/** Which email nudge (Resend) is due for an experiment, if any. */
export function dueNudge(
  exp: { status: ExperimentStatus; hasLiftResult?: boolean },
): "publish_pending" | "result_ready" | null {
  if (exp.status === "awaiting_publish") return "publish_pending";
  if (exp.status === "complete" && exp.hasLiftResult) return "result_ready";
  return null;
}
