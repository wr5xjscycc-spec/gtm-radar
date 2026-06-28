// P2 (Measurement) — minimal projection of the CONTRACT §7 `experiment` record.
//
// P2·5 re-measures an experiment's pre/post citation rates, but P4 (which OWNS the experiment
// record and the causal DiD) doesn't exist yet. Per the contract spec we code against a FIXTURE
// of the experiment shape and note the assumption — this file is that fixture's typed projection,
// holding ONLY the fields P2 re-measurement reads. It deliberately mirrors contract-records.ts:
// do NOT add fields to "extend" the contract; that needs ORCHESTRATION.md §4 sign-off, and P4 owns
// the authoritative schema. When real P4 data lands this projection drops in unchanged.

/**
 * Lifecycle of an experiment (P1/P4 own the transitions). P2 doesn't gate on status — it
 * re-measures whatever window it's handed — but the field rides along for completeness/logging.
 */
export type ExperimentStatus =
  | "designing"
  | "awaiting_publish"
  | "running"
  | "complete"
  | "expired";

/**
 * One matched treatment/control pair in an experiment. The treatment page is the changed page;
 * the control is the matched, unchanged page used as the DiD counterfactual. `match_covars` is the
 * (P4-owned) record of what the pages were matched on — opaque to P2, carried but never read here.
 */
export interface ExperimentPair {
  /** Page url of the changed page. */
  treatment_page: string;
  /** Page url of the matched, unchanged page. */
  control_page: string;
  /** What the pair was matched on (P4 semantics) — opaque to P2. */
  match_covars?: Record<string, unknown>;
}

/**
 * Projection of the `experiment` record (CONTRACT §7) — the fields P2 re-measurement needs.
 * `baseline_window` / `post_window` are OPAQUE window ids/labels: P1 owns their semantics, P2 only
 * threads them through as tags. `publish_event_ts` is optional because a not-yet-published
 * experiment has no publish event.
 */
export interface ExperimentRecord {
  id: string;
  customer_id: string;
  pairs: ExperimentPair[];
  /** Opaque window id/label for the pre-change window (P1 owns semantics). */
  baseline_window: string;
  /** Opaque window id/label for the post-change window. */
  post_window: string;
  status: ExperimentStatus;
  /** Epoch ms of the publish event, if published. */
  publish_event_ts?: number;
}

/** Which side of an experiment a page sits on. */
export type Arm = "treatment" | "control";

/**
 * Which arm (if any) a page url belongs to in this experiment.
 *
 * Does an EXACT string match of `pageUrl` against every pair's `treatment_page` / `control_page`.
 * Exact (not normalized/prefix) on purpose: arm pages come straight from the experiment record and
 * the measurement rows carry the same `page_url`, so any fuzziness here would silently misassign a
 * near-miss url into an arm and corrupt P4's DiD. A page in NEITHER arm — e.g. a competitor page
 * that shares the candidate pool — returns null (it's measured and tagged, but belongs to no arm).
 *
 * Treatment takes PRECEDENCE if a url somehow appears in both arms (whether within one malformed
 * pair or across pairs): this shouldn't happen in a well-formed experiment, but resolving it
 * deterministically (rather than throwing or returning ambiguous) keeps the partition total and
 * defensive. We therefore scan ALL pairs for a treatment hit before considering any control.
 *
 * Pure: reads only its arguments, returns a fresh value, mutates nothing.
 *
 * @param pageUrl The page url to classify (exact match required).
 * @param experiment The experiment whose pairs define the arms.
 * @returns "treatment" | "control" | null.
 */
export function classifyArm(pageUrl: string, experiment: ExperimentRecord): Arm | null {
  // First pass: treatment precedence — a treatment hit anywhere wins over any control match.
  for (const pair of experiment.pairs) {
    if (pair.treatment_page === pageUrl) {
      return "treatment";
    }
  }
  // Second pass: no treatment matched, so a control hit (if any) classifies the page.
  for (const pair of experiment.pairs) {
    if (pair.control_page === pageUrl) {
      return "control";
    }
  }
  // In neither arm of any pair (competitor/pool page, or empty pairs).
  return null;
}
