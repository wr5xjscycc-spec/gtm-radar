/**
 * Company-understanding card render-state (owner: P1, Phase 1).
 *
 * PRD Stage 1–2: the "here's what you are" card that earns the founder's trust
 * before the gut-punch. P3 fills `company.understanding` progressively (it
 * arrives field-by-field via Convex reactivity), so the card must render its
 * own loading → partial → ready states rather than blocking on full enrichment.
 *
 * Pure + unit-tested; the React card (App.tsx) is a thin renderer over this.
 */

export interface Understanding {
  category?: string;
  icp?: string;
  positioning?: string;
  what_you_are?: string;
}

export type CardStatus = "reading" | "partial" | "ready";

export interface CardState {
  status: CardStatus;
  /** Fields present so far (for rendering). */
  fields: Required<Understanding>;
  /** Which understanding fields are still missing. */
  missing: (keyof Understanding)[];
  /** True when nothing has landed yet — show "reading your site…". */
  isReading: boolean;
}

const ORDER: (keyof Understanding)[] = [
  "category",
  "positioning",
  "what_you_are",
  "icp",
];

// The card is "ready" only when the trust-building essentials have landed.
const REQUIRED: (keyof Understanding)[] = ["category", "positioning", "what_you_are"];

function present(v: string | undefined): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

export function companyCardState(u: Understanding | undefined | null): CardState {
  const understanding = u ?? {};
  const missing = ORDER.filter((k) => !present(understanding[k]));
  const have = ORDER.filter((k) => present(understanding[k]));

  let status: CardStatus;
  if (have.length === 0) status = "reading";
  else if (REQUIRED.every((k) => present(understanding[k]))) status = "ready";
  else status = "partial";

  return {
    status,
    isReading: status === "reading",
    missing,
    fields: {
      category: understanding.category?.trim() ?? "",
      icp: understanding.icp?.trim() ?? "",
      positioning: understanding.positioning?.trim() ?? "",
      what_you_are: understanding.what_you_are?.trim() ?? "",
    },
  };
}

/**
 * Battlefield-filling progress for the board (companies arrive from P3 as
 * role=battlefield rows). Returns a small view model for the "filling" state.
 */
export function battlefieldProgress(
  companies: { role: string }[],
  target = 20,
): { count: number; filling: boolean; target: number } {
  const count = companies.filter(
    (c) => c.role === "battlefield" || c.role === "competitor",
  ).length;
  return { count, filling: count < target, target };
}
