// Extractor hardening — subjective-feature AGREEMENT spot-checks (P3 · Phase 3, task #2).
//
// EPISTEMIC LAYER: this whole module lives at the `measurement` layer (CONTRACT.md
// "Three epistemic layers, never blurred"). The numbers it produces are a
// DESCRIPTIVE measurement-error disclosure — an honesty signal about how noisy the
// gpt-4o-mini-extracted subjective features are. They are NOT a `model_fit`
// hypothesis and NEVER a `lift_result` causal claim. Agreement says "rater A and
// rater B concur on feature X this often"; it says nothing about citations or lift.
//
// HONESTY RULE (phase card): report the agreement number even when it's mediocre.
// `computeAgreement` therefore returns EVERY subjective feature, every run — it
// never drops a feature because it scored low, and it never silently hides a bad κ.
//
// VERSIONING (CONTRACT.md global rule "everything derived is versioned"): the report
// stamps `extractor_version` (default CONTENT_EXTRACTOR_VERSION from features.ts) so
// a mid-run extractor change is detectable and reproducible.

import type { ChatModel } from "./understanding";
import { CONTENT_EXTRACTOR_VERSION, extractSubjectiveFeatures } from "./features";
import type {
  AgreementReport,
  FeatureAgreement,
  SubjectiveContentFeatures,
} from "./types";

/** One labeled comparison row: an extractor PREDICTION paired with a GOLD/2nd-rater label. */
export interface LabeledItem {
  predicted: SubjectiveContentFeatures;
  gold: SubjectiveContentFeatures;
}

/** Options for the agreement computation. */
export interface AgreementOptions {
  /**
   * Absolute tolerance for the numeric (density) features. Default 1.0 in the
   * feature's own units (per-1000-words). An item COUNTS AS AGREEING when
   * |predicted - gold| <= tolerance (boundary inclusive — exactly-at-tolerance agrees).
   */
  tolerance?: number;
  /** Override the stamped extractor version (default CONTENT_EXTRACTOR_VERSION). */
  extractorVersion?: string;
}

/** Default absolute tolerance for numeric density features (per-1000-words units). */
export const DEFAULT_TOLERANCE = 1.0;

// ─────────────────────────────────────────────────────────────────────────────
// Metric-per-feature map (documented choices):
//   direct_answer_first  (boolean)     → cohens_kappa  (binary κ; exact fallback)
//   listicle_vs_prose    (categorical) → cohens_kappa  (3-category κ; exact fallback)
//   stats_density        (numeric)     → within_tolerance
//   citation_density     (numeric)     → within_tolerance
//   quote_density        (numeric)     → within_tolerance
// Order mirrors types.ts SubjectiveContentFeatures so the report is stable.
// ─────────────────────────────────────────────────────────────────────────────

type Metric = "categorical" | "numeric";

const FEATURE_METRICS: ReadonlyArray<[keyof SubjectiveContentFeatures, Metric]> = [
  ["direct_answer_first", "categorical"],
  ["stats_density", "numeric"],
  ["citation_density", "numeric"],
  ["quote_density", "numeric"],
  ["listicle_vs_prose", "categorical"],
];

/** Result of a single-feature agreement computation. */
interface MetricResult {
  agreement: number;
  method: FeatureAgreement["method"];
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Cohen's κ over two raters for a categorical/boolean feature, generalized to any
 * number of categories.
 *
 *   po = observed agreement (fraction of items where the two raters concur)
 *   pe = chance agreement   = Σ_c  p_predicted(c) · p_gold(c)
 *   κ  = (po - pe) / (1 - pe),  clamped to [-1, 1]
 *
 * KAPPA-SIGN CONVENTION: we report κ's TRUE value, clamped to [-1, 1]. We do NOT
 * floor it at 0 — a below-chance κ (negative) is a real, honest signal that the
 * extractor disagrees with the gold worse than random, so we disclose it as-is.
 * (The FeatureAgreement.agreement "0..1" note is the nominal range; κ may sit below
 * it, which is the whole point of an honest measurement-error disclosure.)
 *
 * FALLBACK: when pe == 1 — i.e. BOTH raters assigned every item to the same single
 * category (a degenerate constant rater) — κ is undefined (divide-by-zero). We then
 * fall back to raw "exact" agreement (po) and tag the method "exact", so we never
 * crash and never emit NaN.
 */
function cohensKappa(predicted: string[], gold: string[]): MetricResult {
  const n = predicted.length;
  if (n === 0) {
    // Documented n=0 value: 0 agreement, no divide-by-zero (see computeAgreement).
    return { agreement: 0, method: "cohens_kappa" };
  }

  let agree = 0;
  const predCounts = new Map<string, number>();
  const goldCounts = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    if (predicted[i] === gold[i]) agree++;
    predCounts.set(predicted[i], (predCounts.get(predicted[i]) ?? 0) + 1);
    goldCounts.set(gold[i], (goldCounts.get(gold[i]) ?? 0) + 1);
  }
  const po = agree / n;

  let pe = 0;
  for (const [cat, pc] of predCounts) {
    const gc = goldCounts.get(cat) ?? 0;
    pe += (pc / n) * (gc / n);
  }

  // pe == 1 ⇒ both raters constant on one category ⇒ κ undefined. Fall back to raw.
  if (1 - pe <= 0) {
    return { agreement: po, method: "exact" };
  }

  const kappa = (po - pe) / (1 - pe);
  return { agreement: clamp(kappa, -1, 1), method: "cohens_kappa" };
}

/**
 * Within-tolerance agreement for a numeric feature: the fraction of items whose
 * |predicted - gold| <= tolerance. Boundary inclusive. n=0 ⇒ 0 (documented).
 */
function withinTolerance(predicted: number[], gold: number[], tolerance: number): MetricResult {
  const n = predicted.length;
  if (n === 0) return { agreement: 0, method: "within_tolerance" };
  let pass = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(predicted[i] - gold[i]) <= tolerance) pass++;
  }
  return { agreement: pass / n, method: "within_tolerance" };
}

/** Stringify a feature value into a categorical key for κ (booleans → "true"/"false"). */
function categoryKey(v: SubjectiveContentFeatures[keyof SubjectiveContentFeatures]): string {
  return String(v);
}

/**
 * Compute per-feature agreement between predicted and gold subjective vectors.
 *
 * Returns an AgreementReport with one FeatureAgreement per subjective feature (5,
 * always — even mediocre/low scores are reported, never dropped). `n` is the size
 * of the labeled subset. n=0 is handled gracefully: every feature reports
 * agreement 0 (documented, never NaN, never a throw).
 */
export function computeAgreement(items: LabeledItem[], opts: AgreementOptions = {}): AgreementReport {
  const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE;
  const extractor_version = opts.extractorVersion ?? CONTENT_EXTRACTOR_VERSION;
  const n = items.length;

  const features: FeatureAgreement[] = FEATURE_METRICS.map(([feature, metric]) => {
    let result: MetricResult;
    if (metric === "numeric") {
      const pred = items.map((it) => it.predicted[feature] as number);
      const gold = items.map((it) => it.gold[feature] as number);
      result = withinTolerance(pred, gold, tolerance);
    } else {
      const pred = items.map((it) => categoryKey(it.predicted[feature]));
      const gold = items.map((it) => categoryKey(it.gold[feature]));
      result = cohensKappa(pred, gold);
    }
    return { feature, method: result.method, agreement: result.agreement, n };
  });

  return { extractor_version, features, n };
}

/** A labeled evaluation item: the raw page plus its GOLD/second-rater label. */
export interface LabeledEvalItem {
  url: string;
  text: string;
  gold: SubjectiveContentFeatures;
}

/**
 * Run the real extractor over a labeled subset and report its agreement with the
 * gold labels.
 *
 * For each labeled item we call `extractSubjectiveFeatures` (the same versioned
 * extractor used in production) to get a prediction, pair it with the gold label,
 * then hand the pairs to `computeAgreement`.
 *
 * THROW HANDLING: if the extractor throws on an item (bad/empty model reply — it
 * "fails loud" by design), we EXCLUDE that item from the comparison rather than
 * fabricate a prediction. The reported `n` therefore reflects only successfully
 * extracted items — an honest denominator, never padded.
 */
export async function evaluateExtractor(
  model: ChatModel,
  labeled: LabeledEvalItem[],
  opts: AgreementOptions = {},
): Promise<AgreementReport> {
  const items: LabeledItem[] = [];
  for (const item of labeled) {
    let predicted: SubjectiveContentFeatures;
    try {
      predicted = await extractSubjectiveFeatures(model, { url: item.url, text: item.text });
    } catch {
      // Extraction failed loud — exclude (don't fabricate); n drops accordingly.
      continue;
    }
    items.push({ predicted, gold: item.gold });
  }
  // Surface attrition explicitly so a systemic vendor outage (many skips → low n)
  // is VISIBLE, not silently inferred from a small denominator.
  return {
    ...computeAgreement(items, opts),
    attempted: labeled.length,
    skipped: labeled.length - items.length,
  };
}
