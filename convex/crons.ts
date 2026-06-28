/**
 * Scheduled jobs (owner: P1, Phase 5). Cadence is the cost guard:
 *   - MONTHLY baseline re-measurement (never weekly multi-engine sweeps)
 *   - DAILY expiry sweep for unpublished 14-day slots (free the credits)
 * Event-driven post-window re-measurement is NOT here — it fires on the publish
 * event (see experiments.recordPublish), not on a schedule.
 */
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.monthly(
  "monthly baseline re-measurement",
  { day: 1, hourUTC: 0, minuteUTC: 0 },
  internal.experiments.monthlyBaseline,
);

crons.daily(
  "expire stale publish slots",
  { hourUTC: 1, minuteUTC: 0 },
  internal.experiments.expireStaleSlots,
);

export default crons;
