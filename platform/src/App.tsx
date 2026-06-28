import {
  useState,
  useEffect,
  useMemo,
  Component,
  type ReactNode,
  type CSSProperties,
} from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { normalizeDomain } from "../../convex/lib/domain";
import { companyCardState } from "./companyCard";
import { rankedGaps, makeClaim, RUNG, type Coefficient } from "./claimLadder";
import { formatPcitedCI, score } from "./gutPunch";
import {
  llmExpandRatio,
  seedSourceBreakdown,
  type SeedSource,
} from "./enrichmentReview";

/**
 * Radar — the founder-facing product surface (owner: P1).
 *
 * Three designed screens over one workspace lifecycle, each a reactive view of
 * Convex (no polling — rows fill in as P2/P3/P4 write them):
 *
 *   1. Wizard      — 5-step onboarding → scan → diagnosis → "build the fix"
 *   2. Asset page  — the AI-optimized comparison page Radar generated
 *   3. Lift report — causal experiment result (gated: renders ONLY with a lift_result)
 *
 * The HTML in ../handoff is the high-fidelity reference; this recreates it with
 * inline styles (no CSS framework) wired to the live board queries. The honesty
 * guards are load-bearing and enforced here AND at the data layer:
 *   · causal language is impossible without a lift_result (claimLadder.makeClaim)
 *   · coefficients are rendered as hypotheses ("correlates with", "worth testing")
 *   · per-engine numbers are never silently collapsed into one
 *   · uncertainty (CI ranges) is always shown alongside point estimates
 */

// ─────────────────────────────────────────────────────────────────────────────
// Design tokens (from handoff/PROMPT.md — apply everywhere)
// ─────────────────────────────────────────────────────────────────────────────
const T = {
  pageBg: "#F5F7FA",
  card: "#FFFFFF",
  dark: "#111827",
  ink: "#111827",
  ink2: "#374151",
  muted: "#6B7280",
  label: "#9CA3AF",
  green: "#059669",
  greenDark: "#047857",
  green2: "#10B981",
  greenBg: "#ECFDF5",
  greenBg2: "#F0FDF4",
  greenBorder: "#A7F3D0",
  greenBorder2: "#BBF7D0",
  red: "#DC2626",
  redDark: "#B91C1C",
  redBg: "#FFF5F5",
  redBorder: "#FECACA",
  border: "#E5E7EB",
  divider: "#F3F4F6",
  subtle: "#F9FAFB",
  purple: "#7C3AED",
} as const;

const FONT = "'Plus Jakarta Sans', system-ui, sans-serif";

// Internal feature key → plain English (from PROMPT.md).
const FEATURE_LABELS: Record<string, string> = {
  comparison_table: "Has a comparison page",
  direct_answer_first: "Leads with a direct answer",
  entity_cooccurrence: "Mentioned alongside competitors online",
  word_count: "Content length",
  schema_markup: "Structured data markup",
  stats_density: "Uses data and statistics",
  citation_density: "Cites sources",
  heading_structure: "Well-structured headings",
  freshness_days: "Recently updated",
  query_term_coverage: "Covers buyer keywords",
};

// Plain-English "why it matters" lines for the top signals (hypothesis-safe copy).
const FEATURE_WHY: Record<string, string> = {
  comparison_table:
    'A page like "you vs competitor" that directly answers the comparison question. AI engines heavily cite these: they match what buyers ask.',
  direct_answer_first:
    "First sentence answers the buyer's question directly. AI pulls exact sentences to cite: the opening line matters most.",
  entity_cooccurrence:
    "In reviews, Reddit threads, comparison lists. Off-site mentions signal to AI that you're a legitimate player in the space.",
  word_count: "Word count made no difference. Clearer beats longer.",
};

// Noise-stage copy: a noise row must NEVER reuse the positive endorsements in
// FEATURE_WHY (those would contradict the "Not a signal" verdict). Default to a
// noise-framed line; only word_count already has noise-appropriate copy.
const FEATURE_WHY_NOISE: Record<string, string> = {
  word_count: "Word count made no difference. Clearer beats longer.",
};

// ─────────────────────────────────────────────────────────────────────────────
// Tiny hash router  (#/wizard · #/wizard/<id> · #/asset/<id> · #/lift/<id>)
// ─────────────────────────────────────────────────────────────────────────────
type Screen = "wizard" | "asset" | "lift";
interface Route {
  screen: Screen;
  workspaceId?: Id<"workspaces">;
}

// A Convex workspace id is an opaque token; treat a hash segment as one ONLY when
// it is syntactically plausible. This keeps an obviously-malformed deep-link
// (#/asset/garbage) from reaching the data layer and throwing arg-validation —
// it routes to the wizard / asset-gate instead of blanking the screen.
function plausibleId(id: string | undefined): id is string {
  return !!id && /^[a-z0-9_-]{16,}$/i.test(id);
}

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [screen, id] = raw.split("/");
  const wsId = plausibleId(id) ? (id as Id<"workspaces">) : undefined;
  if (screen === "asset" || screen === "lift")
    return { screen, workspaceId: wsId };
  return { screen: "wizard", workspaceId: wsId };
}

/**
 * Reveal a degraded affordance after a grace period instead of hard-blocking the
 * founder behind data that may never arrive. Returns whole elapsed seconds while
 * `active`, and resets to 0 when inactive (mirrors step 2's readSecs time-box).
 */
function useElapsedSeconds(active: boolean): number {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (!active) {
      setSecs(0);
      return;
    }
    const started = Date.now();
    const id = setInterval(
      () => setSecs(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(id);
  }, [active]);
  return secs;
}

function toHash(r: Route): string {
  return `#/${r.screen}${r.workspaceId ? `/${r.workspaceId}` : ""}`;
}

function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash());
  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const navigate = (r: Route) => {
    const h = toHash(r);
    if (window.location.hash !== h) window.location.hash = h;
    setRoute(r);
    window.scrollTo({ top: 0 });
  };
  return [route, navigate];
}

// ─────────────────────────────────────────────────────────────────────────────
// Domain / aggregation helpers (frontend mirrors of the board's classification)
// ─────────────────────────────────────────────────────────────────────────────
function host(u: string): string {
  try {
    const url = new URL(/^https?:\/\//.test(u) ? u : `https://${u}`);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return u.replace(/^www\./, "").split("/")[0];
  }
}
const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * Turn whatever the founder typed into a measurable domain. Accepts a domain
 * ("acme.com"), a pasted URL ("https://www.acme.com/about"), or a bare company
 * name ("Acme", "Acme Corp") — a name with no dot assumes `.com`. Returns the
 * resolved domain, a display name, and whether the TLD was guessed (so the UI can
 * show "we'll scan acme.com" for transparency). Returns null only when there's
 * nothing usable to scan.
 */
function resolveCompany(
  raw: string,
): { domain: string; name: string; guessed: boolean } | null {
  const typed = raw.trim();
  if (!typed) return null;
  let s = typed
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .replace(/\s+/g, "");
  if (!s) return null;
  const guessed = !s.includes(".");
  if (guessed) s = `${s}.com`;
  if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(s)) return null;
  return { domain: s, name: guessed ? typed : host(s), guessed };
}

interface Side {
  cited: number;
  total: number;
}
interface LeaderRow {
  domain: string;
  cited: number;
  total: number;
  rate: number;
  you: boolean;
}

type PerEngine = Record<
  string,
  {
    you: Side;
    competitors: Record<string, Side>;
    topCompetitor: (Side & { domain: string }) | null;
    citedSources: string[];
  }
>;

/** Collapse the per-engine board into one combined per-domain leaderboard. */
function buildLeaderboard(
  gut: { own_domain: string; perEngine: PerEngine } | undefined | null,
): LeaderRow[] {
  if (!gut) return [];
  const own = gut.own_domain;
  const agg = new Map<string, Side>();
  const bump = (dom: string, s: Side) => {
    const cur = agg.get(dom) ?? { cited: 0, total: 0 };
    cur.cited += s.cited;
    cur.total += s.total;
    agg.set(dom, cur);
  };
  for (const e of Object.values(gut.perEngine)) {
    bump(own, e.you);
    for (const [dom, s] of Object.entries(e.competitors)) bump(dom, s);
  }
  return [...agg.entries()]
    .filter(([, s]) => s.total > 0)
    .map(([domain, s]) => ({
      domain,
      cited: s.cited,
      total: s.total,
      rate: s.total ? s.cited / s.total : 0,
      you: domain === own,
    }))
    .sort((a, b) => b.rate - a.rate);
}

/**
 * Wilson score lower bound for a cited/total proportion — a sample-size-aware
 * ranking key. A domain measured 1/1 (raw rate 100%) scores far below a 9/12
 * (raw 75%) because a single draw carries almost no confidence, so a small-sample
 * noise domain can never be promoted to "the competitor" over a real one.
 */
function wilsonLower(cited: number, total: number): number {
  if (total <= 0) return 0;
  const z = 1.96;
  const phat = cited / total;
  const denom = 1 + (z * z) / total;
  const centre = phat + (z * z) / (2 * total);
  const margin =
    z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * total)) / total);
  return Math.max(0, (centre - margin) / denom);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared chrome
// ─────────────────────────────────────────────────────────────────────────────
function GlobalStyle() {
  return (
    <style>{`
      @keyframes pulse-dot { 0%,100%{opacity:1} 50%{opacity:.2} }
      @keyframes step-in { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
      @keyframes reading { 0%,100%{opacity:.4} 50%{opacity:1} }
      @keyframes count-up { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
      @keyframes rdr-marquee { from{transform:translateX(0)} to{transform:translateX(-50%)} }
      .rdr-ticker { overflow:hidden; -webkit-mask-image:linear-gradient(90deg,transparent,#000 7%,#000 93%,transparent); mask-image:linear-gradient(90deg,transparent,#000 7%,#000 93%,transparent); }
      .rdr-ticker-track { display:inline-flex; gap:8px; white-space:nowrap; animation:rdr-marquee 32s linear infinite; will-change:transform; }
      .rdr-ticker:hover .rdr-ticker-track { animation-play-state:paused; }
      body { margin:0; background:${T.pageBg}; font-family:${FONT}; }
      .rdr-input { font-family:inherit; }
      .rdr-input::placeholder { color:#6B7280; opacity:1; }
      .rdr-input:focus { outline:none; }
      .rdr-input:focus-visible, button:focus-visible, a:focus-visible { outline:2px solid #047857; outline-offset:2px; border-radius:6px; }
      button:not(:disabled){ cursor:pointer; transition:filter .15s ease, transform .06s ease; }
      button:not(:disabled):hover{ filter:brightness(0.96); }
      button:not(:disabled):active{ transform:translateY(1px); filter:brightness(0.92); }
      @media (prefers-reduced-motion: reduce){ *,*::before,*::after{ animation-duration:.001ms !important; animation-iteration-count:1 !important; transition-duration:.001ms !important; scroll-behavior:auto !important; } }
      .rdr-grid-2{ display:grid; grid-template-columns:1fr 1fr; }
      .rdr-grid-3{ display:grid; grid-template-columns:1fr 1fr 1fr; }
      .rdr-beforeafter{ display:grid; grid-template-columns:1fr auto 1fr; }
      @media (max-width:680px){ .rdr-grid-2,.rdr-grid-3,.rdr-beforeafter{ grid-template-columns:1fr; } .rdr-nav{ padding-left:20px !important; padding-right:20px !important; } .rdr-padx{ padding-left:20px !important; padding-right:20px !important; } .rdr-arrow{ transform:rotate(90deg); } .rdr-col-l{ padding-right:0 !important; border-right:none !important; padding-bottom:16px; border-bottom:1px solid ${T.divider}; } .rdr-col-r{ padding-left:0 !important; padding-top:16px; } }
      .rdr-table { border-collapse:collapse; width:100%; }
      .rdr-table th, .rdr-table td { text-align:left; padding:12px 16px; border-bottom:1px solid ${T.border}; font-family:${FONT}; }
      .rdr-table th { font-size:11px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:${T.label}; background:${T.subtle}; }
      .rdr-table td { font-size:14px; color:${T.ink2}; }
      .rdr-table td:first-child { font-weight:500; color:${T.ink}; }
      .rdr-table tr:last-child td { border-bottom:none; }
    `}</style>
  );
}

function LiveBadge() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: T.green,
            display: "inline-block",
            animation: "pulse-dot 2s ease-in-out infinite",
          }}
        />
        <span style={{ fontSize: 13, fontWeight: 500, color: T.green }}>
          Live
        </span>
      </div>
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: ".06em",
          textTransform: "uppercase",
          color: T.muted,
          background: T.divider,
          padding: "5px 12px",
          borderRadius: 4,
        }}
      >
        Real data · not estimated
      </span>
    </div>
  );
}

// The wordmark, clickable → home (the wizard landing). Styled to read as the
// brand text; the global button:hover/focus-visible rules give it affordance.
function RadarBrand({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Radar — go home"
      title="Go home"
      style={{
        fontWeight: 800,
        fontSize: 16,
        color: T.ink,
        letterSpacing: "-.02em",
        fontFamily: FONT,
        background: "none",
        border: "none",
        padding: 0,
        cursor: "pointer",
        lineHeight: 1,
      }}
    >
      Radar
    </button>
  );
}

function Nav({ children }: { children: ReactNode }) {
  return (
    <div
      className="rdr-nav"
      style={{
        background: T.card,
        borderBottom: `1px solid ${T.border}`,
        padding: "0 48px",
        height: 56,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        position: "sticky",
        top: 0,
        zIndex: 20,
      }}
    >
      {children}
    </div>
  );
}

const navLink: CSSProperties = {
  fontSize: 13,
  color: T.muted,
  textDecoration: "none",
  cursor: "pointer",
  background: "none",
  border: "none",
  fontFamily: FONT,
  padding: 0,
};


/** Catches a render/query failure so one panel error never blanks the screen. */
class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  // In-app recovery: send the founder home and clear the latched failure so the
  // next render is attempted fresh (the route-keyed boundary in App() also
  // remounts on any hashchange, so navigation recovers without a full reload).
  reset = () => {
    if (window.location.hash !== "#/wizard") window.location.hash = "#/wizard";
    this.setState({ failed: false });
  };
  render() {
    if (this.state.failed) {
      return (
        <div
          role="alert"
          style={{
            maxWidth: 720,
            margin: "40px auto",
            padding: 24,
            background: T.card,
            border: `1px solid ${T.border}`,
            borderRadius: 8,
            color: T.muted,
            fontSize: 14,
          }}
        >
          <div style={{ marginBottom: 14 }}>
            Couldn't load this view. Check the connection and reload.
          </div>
          <button onClick={this.reset} style={greenButton}>
            Back to start
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// App root
// ─────────────────────────────────────────────────────────────────────────────
export function App() {
  const [route, navigate] = useRoute();
  return (
    <>
      <GlobalStyle />
      {/* Key by screen only — NOT workspaceId. The wizard's create flow sets the
          id mid-flow (createWorkspace → navigate), and keying on the id would
          remount the wizard right then, wiping its step state and snapping it to
          step 5. Screen-level keying still remounts (and recovers) on a real
          screen change; the fallback's "back to analysis" action covers the rest. */}
      <ErrorBoundary key={route.screen}>
        {route.screen === "asset" ? (
          <AssetScreen workspaceId={route.workspaceId} navigate={navigate} />
        ) : route.screen === "lift" ? (
          <LiftScreen workspaceId={route.workspaceId} navigate={navigate} />
        ) : (
          <WizardScreen workspaceId={route.workspaceId} navigate={navigate} />
        )}
      </ErrorBoundary>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SCREEN 1 — Wizard
// ─────────────────────────────────────────────────────────────────────────────
const EXPECTED_QUERIES = 300; // measurement sweep target (PROMPT: "X / 300 queries")

function WizardScreen({
  workspaceId,
  navigate,
}: {
  workspaceId?: Id<"workspaces">;
  navigate: (r: Route) => void;
}) {
  const createWorkspace = useMutation(api.customers.createWorkspace);

  // Local wizard state. A workspace already in the URL means we're resuming a
  // completed flow → land on the final step (earlier steps collapse to summaries).
  const [step, setStep] = useState(workspaceId ? 5 : 1);
  const [url, setUrl] = useState("");
  const [competitors, setCompetitors] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  const wsId = workspaceId;
  const skip = "skip" as const;

  const battlefield =
    useQuery(api.board.battlefield, wsId ? { workspaceId: wsId } : skip) ?? [];
  const queries =
    useQuery(api.board.queries, wsId ? { workspaceId: wsId } : skip) ?? [];
  const gut = useQuery(api.board.gutPunch, wsId ? { workspaceId: wsId } : skip);
  const measurements =
    useQuery(api.board.measurements, wsId ? { workspaceId: wsId } : skip) ?? [];
  const assetBrief = useQuery(
    api.board.assetBrief,
    wsId ? { workspaceId: wsId } : skip,
  );
  const diagnosis = useQuery(
    api.board.diagnosis,
    wsId ? { workspaceId: wsId } : skip,
  );

  const customer = battlefield.find((c) => c.role === "customer");
  const understanding = customer?.understanding;
  const card = companyCardState(understanding);

  const leaderboard = useMemo(() => buildLeaderboard(gut as any), [gut]);
  const youRow = leaderboard.find((r) => r.you);
  // Headline competitor: rank non-you domains by a sample-size-aware Wilson lower
  // bound, not naked rate, so a 1/1 noise domain never outranks a 9/12 dominant
  // competitor and the big card agrees with the count-based per-engine boxes.
  const topComp = useMemo(() => {
    const comps = leaderboard.filter((r) => !r.you);
    if (comps.length === 0) return null;
    return comps.reduce((best, r) =>
      wilsonLower(r.cited, r.total) > wilsonLower(best.cited, best.total)
        ? r
        : best,
    );
  }, [leaderboard]);

  // Per-domain CI envelope from the rolled-up aggregate measurement rows (the
  // P_cited-bearing rows carry ci_low / ci_high). Keyed by the SAME registrable
  // domain (eTLD+1) the board uses for leaderboard domains — host() keeps
  // subdomains, so a CI row on docs.acme.com would never join acme.com. Domains
  // with no aggregate row simply get no range — we never fabricate one.
  const ciByDomain = useMemo(() => {
    const m = new Map<string, { low: number; high: number }>();
    for (const r of measurements as Array<{
      page_url: string;
      ci_low?: number;
      ci_high?: number;
    }>) {
      if (typeof r.ci_low !== "number" || typeof r.ci_high !== "number") continue;
      const d = normalizeDomain(r.page_url);
      const cur = m.get(d);
      if (!cur) m.set(d, { low: r.ci_low, high: r.ci_high });
      else {
        cur.low = Math.min(cur.low, r.ci_low);
        cur.high = Math.max(cur.high, r.ci_high);
      }
    }
    return m;
  }, [measurements]);

  // Per-engine CI envelope for the OWN domain, from the rolled-up aggregate rows
  // (P_cited + ci_low/ci_high). Per-engine is exactly where single-draw
  // non-determinism bites, so when an aggregate exists EngineBox shows the rate
  // WITH its CI; otherwise it falls back to an honest raw tally.
  const ciByEngine = useMemo(() => {
    const m = new Map<string, { p: number; low: number; high: number }>();
    const ownDom = (gut as any)?.own_domain as string | undefined;
    if (!ownDom) return m;
    for (const r of measurements as Array<{
      engine: string;
      page_url: string;
      P_cited?: number;
      ci_low?: number;
      ci_high?: number;
    }>) {
      if (
        typeof r.P_cited !== "number" ||
        typeof r.ci_low !== "number" ||
        typeof r.ci_high !== "number"
      )
        continue;
      if (normalizeDomain(r.page_url) !== ownDom) continue;
      const cur = m.get(r.engine);
      if (!cur) m.set(r.engine, { p: r.P_cited, low: r.ci_low, high: r.ci_high });
      else {
        cur.p = r.P_cited;
        cur.low = Math.min(cur.low, r.ci_low);
        cur.high = Math.max(cur.high, r.ci_high);
      }
    }
    return m;
  }, [measurements, gut]);
  const gapRatio =
    youRow && youRow.rate > 0 && topComp
      ? Math.max(1, Math.round(topComp.rate / youRow.rate))
      : topComp && topComp.rate > 0
        ? topComp.cited && youRow && youRow.cited
          ? Math.round(topComp.cited / youRow.cited)
          : null
        : null;

  // Live progress + "done" gating (Convex reactivity, no polling). Progress is
  // counted in DISTINCT QUERIES actually measured, not raw measurement rows (a
  // row is per query×page×engine×run, so rows wildly overstate query progress),
  // and the denominator is the real generated query set — falling back to the
  // sweep target only before that set has loaded.
  const sweptQueries = useMemo(() => {
    const seen = new Set<string>();
    for (const r of measurements) seen.add(r.query_id);
    return seen.size;
  }, [measurements]);
  const expectedQueries = queries.length > 0 ? queries.length : EXPECTED_QUERIES;
  const scanPct = Math.min(
    100,
    Math.round((sweptQueries / expectedQueries) * 100),
  );
  const haveEngineData =
    !!gut && Object.keys((gut as any).perEngine ?? {}).length > 0;
  // Complete ONLY when every generated query has at least one measurement — never
  // on the first streamed row, which would assert false completion on partial data.
  const scanDone =
    haveEngineData && queries.length > 0 && sweptQueries >= queries.length;
  const step2Loading = !!wsId && !card.fields.what_you_are;

  // The live pipeline (site read, then the AI sweep) can take a minute or more.
  // Run a visible clock so step 2 reads as working rather than stuck, and after a
  // short grace period reveal the step and its Continue button even if
  // `understanding` hasn't been written yet. The fields still stream in
  // reactively, so the user is never blocked behind a slow or unconfigured
  // enrichment step.
  const [readSecs, setReadSecs] = useState(0);
  useEffect(() => {
    if (step !== 2 || !step2Loading) {
      setReadSecs(0);
      return;
    }
    const started = Date.now();
    const id = setInterval(
      () => setReadSecs(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(id);
  }, [step, step2Loading]);
  const showStep2Loaded = !step2Loading || readSecs >= 8;
  const readClock = `${Math.floor(readSecs / 60)}:${String(readSecs % 60).padStart(2, "0")}`;

  async function startScan() {
    const resolved = resolveCompany(url);
    if (!resolved) {
      setCreateError("Enter your company's website or name, like acme.com or Acme.");
      return;
    }
    setCreateError("");
    setCreating(true);
    try {
      // Resolve each competitor through the SAME helper as the own-domain field
      // so a bare typed name ("Notion") becomes a registrable domain ("notion.com")
      // that can actually join citation source domains — not a dead, dotless key.
      const competitorList = competitors
        .split(",")
        .map((s) => resolveCompany(s)?.domain)
        .filter((d): d is string => Boolean(d));
      const id = await createWorkspace({
        name: resolved.name,
        vertical: "",
        own_domain: resolved.domain,
        competitor_domains: competitorList,
        // Fire the live battlefield build + OpenAI baseline sweep so the board
        // fills with real "you N/M vs competitor" data.
        measure_on_create: true,
      });
      setStep(2);
      navigate({ screen: "wizard", workspaceId: id as Id<"workspaces"> });
    } catch {
      setCreateError("Couldn't start the scan. Check the connection and retry.");
    } finally {
      setCreating(false);
    }
  }

  const fit = diagnosis?.modelFits?.[0];
  const gaps = fit ? rankedGaps(fit.coefficients as Coefficient[]) : null;
  const topSignal = gaps?.surviving?.[0];

  // Grace time-boxes (like step 2): never strand the founder behind data that may
  // never arrive. After a short wait on a non-advancing step, reveal a Continue
  // button + an honest state; the data still streams in reactively afterward.
  const scanSecs = useElapsedSeconds(step === 3 && !scanDone);
  const scanGrace = !scanDone && scanSecs >= 30;
  const step4Pending = step === 4 && (!fit || !gaps);
  const step4Secs = useElapsedSeconds(step4Pending);
  const step4Grace = step4Pending && step4Secs >= 15;

  return (
    <div style={{ minHeight: "100vh", background: T.pageBg }}>
      <Nav>
        <RadarBrand onClick={() => navigate({ screen: "wizard" })} />
        <LiveBadge />
      </Nav>

      <div
        style={{
          maxWidth: 720,
          margin: "0 auto",
          padding: "40px 32px 80px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {/* ═══ STEP 01 — Your details ═══ */}
        {step > 1 ? (
          <DoneBar
            n="01"
            title="Your details"
            summary={`${url || customer?.domain || "your site"}${
              competitors ? ` · ${competitors}` : ""
            }`}
            onEdit={() => setStep(1)}
            label="Edit"
          />
        ) : (
          <StepCard n="01" title="Your details" active>
            <div
              style={{
                background: T.subtle,
                border: `1px solid ${T.divider}`,
                borderRadius: 6,
                padding: "14px 16px",
                marginBottom: 20,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: T.ink2,
                  marginBottom: 4,
                }}
              >
                What we'll do
              </div>
              <div
                style={{ fontSize: 13, color: T.muted, lineHeight: 1.6 }}
              >
                We run real questions buyers type into AI assistants, then record
                exactly who gets cited and who gets ignored. No guessing, no
                scores: raw measurements.
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  marginTop: 10,
                  flexWrap: "wrap",
                }}
              >
                {["ChatGPT", "Perplexity", "Gemini"].map((e) => (
                  <span key={e} style={pill}>
                    {e}
                  </span>
                ))}
                <span
                  style={{
                    fontSize: 11,
                    color: T.label,
                    padding: "4px 0",
                    alignSelf: "center",
                  }}
                >
                  · ~10 minutes
                </span>
              </div>
            </div>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 14,
                marginBottom: 24,
              }}
            >
              <Field label="Your website" htmlFor="wiz-url">
                <input
                  id="wiz-url"
                  className="rdr-input"
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="yourdomain.com"
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "11px 14px",
                    border: `1.5px solid ${T.green}`,
                    borderRadius: 6,
                    fontSize: 15,
                    fontWeight: 600,
                    color: T.ink,
                    background: T.greenBg2,
                  }}
                />
                {(() => {
                  const r = resolveCompany(url);
                  if (!r) return null;
                  const typedNorm = url
                    .trim()
                    .toLowerCase()
                    .replace(/^https?:\/\//, "")
                    .replace(/^www\./, "")
                    .replace(/\/.*$/, "");
                  if (typedNorm === r.domain) return null;
                  return (
                    <div
                      style={{
                        fontSize: 12,
                        color: T.green,
                        marginTop: 6,
                        fontWeight: 500,
                      }}
                    >
                      We'll scan {r.domain}
                    </div>
                  );
                })()}
              </Field>
              <Field
                label="Competitors to compare against"
                htmlFor="wiz-competitors"
              >
                <input
                  id="wiz-competitors"
                  className="rdr-input"
                  type="text"
                  value={competitors}
                  onChange={(e) => setCompetitors(e.target.value)}
                  placeholder="competitor1.com, competitor2.com"
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "11px 14px",
                    border: `1px solid ${T.border}`,
                    borderRadius: 6,
                    fontSize: 14,
                    color: T.ink2,
                    background: "#FAFAFA",
                  }}
                />
                <div style={{ fontSize: 12, color: T.muted, marginTop: 6 }}>
                  We'll also find ~20 other companies in your space automatically
                </div>
              </Field>
            </div>

            <button
              onClick={startScan}
              disabled={creating}
              style={{
                ...darkButton,
                opacity: creating ? 0.6 : 1,
                cursor: creating ? "default" : "pointer",
              }}
            >
              {creating ? "Starting…" : "Start the scan →"}
            </button>
            {createError && (
              <div
                role="alert"
                style={{ color: T.red, fontSize: 13, marginTop: 10 }}
              >
                {createError}
              </div>
            )}
          </StepCard>
        )}

        {/* ═══ STEP 02 — We read your site ═══ */}
        {step < 2 ? (
          <LockedBar n="02" title="We read your site" />
        ) : step > 2 ? (
          <DoneBar
            n="02"
            title="We read your site"
            summary={card.fields.what_you_are || "Reading your site…"}
            onEdit={() => setStep(2)}
            label="Edit"
          />
        ) : (
          <StepCard
            n="02"
            title="We read your site"
            active
            headerExtra={
              step2Loading ? (
                <span
                  style={{
                    fontSize: 12,
                    color: T.label,
                    animation: "reading 1.2s ease-in-out infinite",
                  }}
                >
                  Reading…
                </span>
              ) : (
                <DoneChip />
              )
            }
          >
            {!showStep2Loaded ? (
              <div
                style={{
                  padding: "40px 0",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 16,
                }}
              >
                <div
                  style={{
                    fontSize: 15,
                    color: T.ink2,
                    animation: "reading 1.2s ease-in-out infinite",
                  }}
                >
                  Reading {url || customer?.domain || "your site"}…
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  {[0, 0.2, 0.4].map((d) => (
                    <span
                      key={d}
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: T.green,
                        animation: "reading 1.2s ease-in-out infinite",
                        animationDelay: `${d}s`,
                      }}
                    />
                  ))}
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: T.muted,
                    textAlign: "center",
                    maxWidth: 380,
                    lineHeight: 1.6,
                  }}
                >
                  Figuring out what you do, who you sell to, and what makes you
                  different. This usually takes under a minute.
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: T.label,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {readClock} elapsed
                </div>
              </div>
            ) : (
              <>
                <div
                  style={{
                    fontSize: 16,
                    fontWeight: 600,
                    color: T.ink,
                    lineHeight: 1.5,
                    marginBottom: 20,
                    paddingBottom: 20,
                    borderBottom: `1px solid ${T.divider}`,
                  }}
                >
                  {card.fields.what_you_are
                    ? `“${card.fields.what_you_are}”`
                    : "Still reading your site. The details below fill in as they land."}
                </div>
                <div
                  className="rdr-grid-3"
                  style={{
                    gap: 10,
                    marginBottom: 20,
                  }}
                >
                  <MiniStat
                    label="Category"
                    value={card.fields.category || "—"}
                  />
                  <MiniStat label="Customer" value={card.fields.icp || "—"} />
                  <MiniStat
                    label="Your angle"
                    value={card.fields.positioning || "—"}
                  />
                </div>
                <div style={{ marginBottom: 20 }}>
                  <Label>Questions buyers in your space are asking AI</Label>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                      marginTop: 10,
                    }}
                  >
                    {queries.slice(0, 3).map((q) => (
                      <div
                        key={q._id}
                        style={{
                          ...queryRow,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 10,
                        }}
                      >
                        <span>“{q.text}”</span>
                        <SeedTag source={q.seed_source} />
                      </div>
                    ))}
                    {queries.length === 0 && (
                      <div style={{ ...queryRow, color: T.label }}>
                        Generating buyer questions…
                      </div>
                    )}
                    {queries.length > 3 && (
                      <div
                        style={{
                          fontSize: 13,
                          color: T.label,
                          padding: "4px 14px",
                        }}
                      >
                        + {queries.length - 3} more
                      </div>
                    )}
                  </div>
                  <QueryGrounding queries={queries} />
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <div style={{ fontSize: 12, color: T.muted }}>
                    {step2Loading
                      ? "Still reading in the background. You can start the scan now."
                      : "Not right? Edit any field above."}
                  </div>
                  <button onClick={() => setStep(3)} style={greenButton}>
                    Continue →
                  </button>
                </div>
              </>
            )}
          </StepCard>
        )}

        {/* ═══ STEP 03 — Your AI visibility ═══ */}
        {step < 3 ? (
          <LockedBar n="03" title="Your AI visibility" />
        ) : step > 3 ? (
          <DoneBar
            n="03"
            title="Your AI visibility"
            summary={
              youRow && topComp
                ? `You: ${pct(youRow.rate)} · Top competitor: ${pct(
                    topComp.rate,
                  )}${gapRatio ? ` · ${gapRatio}× gap` : ""}`
                : "Scan complete"
            }
            onEdit={() => setStep(3)}
            label="Review"
          />
        ) : (
          <StepCard
            n="03"
            title="Your AI visibility"
            active
            headerExtra={
              scanDone ? (
                <span style={{ ...doneChipStyle, marginLeft: "auto" }}>
                  ✓ Scan complete
                </span>
              ) : (
                <div
                  style={{
                    marginLeft: "auto",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <span
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: "50%",
                      background: T.green,
                      display: "inline-block",
                      animation: "pulse-dot 1.4s ease-in-out infinite",
                    }}
                  />
                  <span
                    style={{ fontSize: 11, color: T.green, fontWeight: 500 }}
                  >
                    Sweeping… {sweptQueries} / {expectedQueries} queries
                  </span>
                </div>
              )
            }
          >
            <div
              style={{
                position: "relative",
                height: 4,
                background: T.divider,
                borderRadius: 2,
                marginBottom: 6,
              }}
            >
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  height: 4,
                  background: T.green,
                  borderRadius: 2,
                  width: `${scanDone ? 100 : scanPct}%`,
                  transition: "width .3s linear",
                }}
              />
            </div>
            <div style={{ fontSize: 12, color: T.muted, marginBottom: 14 }}>
              Running live buyer questions through ChatGPT · Perplexity · Gemini
            </div>

            {/* live ticker of the actual buyer questions being measured */}
            {queries.length > 0 && (
              <div style={{ marginBottom: 22 }}>
                <QueryTicker queries={queries} />
              </div>
            )}

            {/* gut-punch comparison cards */}
            <div
              className="rdr-grid-2"
              style={{
                gap: 12,
                marginBottom: 16,
              }}
            >
              <BigNumberCard
                kind="you"
                domain={youRow?.domain ?? host(url || customer?.domain || "you")}
                count={youRow?.cited ?? 0}
                total={youRow?.total ?? 0}
                rate={youRow?.rate ?? 0}
                ci={youRow ? ciByDomain.get(normalizeDomain(youRow.domain)) : undefined}
              />
              <BigNumberCard
                kind="competitor"
                domain={topComp?.domain ?? "top competitor"}
                count={topComp?.cited ?? 0}
                total={topComp?.total ?? 0}
                rate={topComp?.rate ?? 0}
                ci={topComp ? ciByDomain.get(normalizeDomain(topComp.domain)) : undefined}
              />
            </div>

            {scanDone && (
              <div style={{ animation: "step-in .4s ease-out forwards" }}>
                <Label>All competitors ranked</Label>
                <div
                  style={{
                    border: `1px solid ${T.divider}`,
                    borderRadius: 6,
                    overflow: "hidden",
                    margin: "10px 0 16px",
                  }}
                >
                  {leaderboard.slice(0, 8).map((r, i) => (
                    <LeaderRowView
                      key={r.domain}
                      rank={r.you ? "—" : String(i + 1)}
                      row={r}
                      max={leaderboard[0]?.rate || 1}
                      isTopCompetitor={!r.you && topComp != null && r.domain === topComp.domain}
                    />
                  ))}
                </div>

                {/* Honesty: the combined leaderboard sums cited/total across engines.
                    Surface the board's own disclaimer so the cross-engine aggregate
                    is explicitly labeled (per-engine boxes stay below). */}
                {(gut as any)?.note && (
                  <div
                    style={{
                      fontSize: 11,
                      color: T.label,
                      lineHeight: 1.5,
                      margin: "0 0 16px",
                    }}
                  >
                    {(gut as any).note}
                  </div>
                )}

                {/* per-engine boxes (never collapsed into one number) */}
                <div
                  className="rdr-grid-3"
                  style={{
                    gap: 8,
                    marginBottom: 16,
                  }}
                >
                  <EngineBox engine="openai" label="ChatGPT" gut={gut as any} youCI={ciByEngine.get("openai")} />
                  <EngineBox engine="perplexity" label="Perplexity" gut={gut as any} youCI={ciByEngine.get("perplexity")} />
                  <EngineBox engine="gemini" label="Gemini" gut={gut as any} youCI={ciByEngine.get("gemini")} />
                </div>

                <div
                  style={{
                    background: T.subtle,
                    border: `1px solid ${T.divider}`,
                    borderRadius: 6,
                    padding: "14px 16px",
                    marginBottom: 20,
                  }}
                >
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: T.ink2,
                      marginBottom: 4,
                    }}
                  >
                    Where AI is citing from in your category
                  </div>
                  <div style={{ fontSize: 13, color: T.muted }}>
                    {citedSourcesText(gut as any) || "—"}
                  </div>
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button onClick={() => setStep(4)} style={greenButton}>
                    Continue →
                  </button>
                </div>
              </div>
            )}

            {/* Time-box escape: if the sweep never completes (zero rows on an
                engine/key failure, or a stall), still let the founder advance
                rather than spin forever — never assert "complete", just degrade. */}
            {!scanDone && scanGrace && (
              <div style={{ marginTop: 16 }}>
                <div
                  style={{
                    fontSize: 13,
                    color: T.muted,
                    lineHeight: 1.6,
                    marginBottom: 12,
                  }}
                >
                  {sweptQueries === 0
                    ? "No measurements have landed yet. The sweep may still be starting, or an engine may be unavailable. You can continue and come back to this."
                    : `Still sweeping in the background (${sweptQueries} of ${expectedQueries} queries measured so far). You can continue; the numbers keep updating live.`}
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button onClick={() => setStep(4)} style={greenButton}>
                    Continue →
                  </button>
                </div>
              </div>
            )}
          </StepCard>
        )}

        {/* ═══ STEP 04 — Why they're getting cited ═══ */}
        {step < 4 ? (
          <LockedBar n="04" title="Why they're getting cited" />
        ) : step > 4 ? (
          <DoneBar
            n="04"
            title="Why they're getting cited"
            summary={
              topSignal
                ? `#1 signal: ${
                    FEATURE_LABELS[topSignal.feature] ?? topSignal.feature
                  } (${topSignal.posterior_median >= 0 ? "+" : ""}${topSignal.posterior_median.toFixed(2)})`
                : "Hypotheses ready"
            }
            onEdit={() => setStep(4)}
            label="Review"
          />
        ) : (
          <StepCard n="04" title="Why they're getting cited" active>
            {!fit || !gaps ? (
              <>
                <PendingNote text="Comparing the pages AI cites vs the ones it ignores…" />
                {/* Time-box escape: a fit that never lands (job failure / too little
                    data) must not strand the founder behind an endless spinner. */}
                {step4Grace && (
                  <>
                    <div
                      style={{
                        fontSize: 13,
                        color: T.muted,
                        lineHeight: 1.6,
                        margin: "8px 0 16px",
                      }}
                    >
                      We don't have enough measured data to rank the citation
                      patterns yet. You can continue; this fills in as the
                      analysis lands.
                    </div>
                    <div style={{ display: "flex", justifyContent: "flex-end" }}>
                      <button onClick={() => setStep(5)} style={greenButton}>
                        Continue →
                      </button>
                    </div>
                  </>
                )}
              </>
            ) : (
              <>
                <div
                  style={{
                    fontSize: 13,
                    color: T.muted,
                    lineHeight: 1.6,
                    marginBottom: 4,
                  }}
                >
                  We compared the pages AI cites vs. the ones it ignores across{" "}
                  <strong style={{ color: T.ink2 }}>
                    {fit.n_companies} similar companies
                  </strong>
                  . These patterns stood out, ranked by correlation strength.
                </div>
                <div
                  style={{ fontSize: 12, color: T.muted, marginBottom: 20 }}
                >
                  Hypotheses, not guarantees. We run an experiment to confirm
                  causation.
                </div>

                <div style={{ borderTop: `1px solid ${T.divider}` }}>
                  {gaps.surviving.slice(0, 3).map((c, i) => (
                    <SignalRow key={c.feature} coef={c} rank={i + 1} />
                  ))}
                  {gaps.noise.slice(0, 1).map((c) => (
                    <NoiseRow key={c.feature} coef={c} />
                  ))}
                </div>

                {topSignal && (
                  <div
                    style={{
                      marginTop: 8,
                      background: T.greenBg2,
                      border: `1px solid ${T.greenBorder}`,
                      borderRadius: 6,
                      padding: "14px 16px",
                      marginBottom: 20,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        color: T.greenDark,
                        marginBottom: 4,
                      }}
                    >
                      Best hypothesis:{" "}
                      {(
                        FEATURE_LABELS[topSignal.feature] ?? topSignal.feature
                      ).toLowerCase()}
                    </div>
                    <div
                      style={{ fontSize: 13, color: T.ink2, lineHeight: 1.6 }}
                    >
                      Strongest pattern we found: it correlates with citation in
                      your category. Worth testing: we'll publish it, then run a
                      randomized experiment to measure whether your citation rate
                      actually goes up.
                    </div>
                  </div>
                )}
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button onClick={() => setStep(5)} style={greenButton}>
                    Continue →
                  </button>
                </div>
              </>
            )}
          </StepCard>
        )}

        {/* ═══ STEP 05 — Your next move (dark) ═══ */}
        {step < 5 ? (
          <LockedBar n="05" title="Your next move" />
        ) : (
          <StepFiveDark
            brief={assetBrief ?? null}
            ownName={
              customer?.name ??
              (youRow?.domain
                ? host(youRow.domain)
                : url
                  ? host(url)
                  : "Your company")
            }
            competitorName={topComp?.domain ?? "your top competitor"}
            category={customer?.understanding?.category}
            currentRate={youRow ? youRow.rate : null}
            topSignalLabel={
              topSignal
                ? FEATURE_LABELS[topSignal.feature] ?? topSignal.feature
                : "a comparison page"
            }
            topSignalFeature={topSignal?.feature}
            signalCoef={
              topSignal
                ? {
                    posterior_median: topSignal.posterior_median,
                    ci_low: topSignal.ci_low,
                    ci_high: topSignal.ci_high,
                  }
                : undefined
            }
            onBuild={() => navigate({ screen: "asset", workspaceId: wsId })}
          />
        )}
      </div>
    </div>
  );
}

// ── Wizard sub-components ────────────────────────────────────────────────────
const pill: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: T.ink2,
  background: T.card,
  border: `1px solid ${T.border}`,
  padding: "4px 10px",
  borderRadius: 20,
};
const darkButton: CSSProperties = {
  display: "inline-block",
  background: T.dark,
  color: "#fff",
  fontWeight: 600,
  fontSize: 13,
  padding: "12px 28px",
  borderRadius: 6,
  cursor: "pointer",
  border: "none",
  fontFamily: FONT,
};
const greenButton: CSSProperties = {
  display: "inline-block",
  background: T.green,
  color: "#fff",
  fontWeight: 600,
  fontSize: 13,
  padding: "11px 28px",
  borderRadius: 6,
  cursor: "pointer",
  border: "none",
  fontFamily: FONT,
};
const queryRow: CSSProperties = {
  fontSize: 13,
  color: T.ink2,
  background: T.subtle,
  border: `1px solid ${T.divider}`,
  borderRadius: 6,
  padding: "10px 14px",
};
const doneChipStyle: CSSProperties = {
  fontSize: 11,
  color: T.green2,
  fontWeight: 600,
  background: T.greenBg,
  padding: "3px 10px",
  borderRadius: 20,
};

function Label({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: ".06em",
        textTransform: "uppercase",
        color: T.label,
      }}
    >
      {children}
    </div>
  );
}

// Plain-English label for each query's grounding source. llm_expand is the only
// ungrounded one (AI-invented) — everything else is seeded from real buyer data.
const SEED_LABELS: Record<SeedSource, string> = {
  paa: "Buyer search",
  keyword: "Keyword data",
  reddit: "Reddit",
  analytics: "Your analytics",
  llm_expand: "AI-expanded",
};

// Per-query grounding tag: distinguishes a query seeded from real buyer data
// (PAA / keyword / Reddit / analytics) from a pure llm_expand one, so an
// AI-invented query is never presented as an observed buyer question.
function SeedTag({ source }: { source: SeedSource }) {
  const grounded = source !== "llm_expand";
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 600,
        color: grounded ? T.green : "#B45309",
        background: grounded ? T.greenBg : "#FFFBEB",
        border: `1px solid ${grounded ? T.greenBorder : "#FDE68A"}`,
        padding: "2px 7px",
        borderRadius: 20,
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      {SEED_LABELS[source] ?? source}
    </span>
  );
}

// Query-set grounding summary: surfaces the seed_source breakdown and warns when
// the set is mostly llm_expand (red-team Theme E) — it never hides an ungrounded
// set, so anyone can see grounded vs AI-invented at a glance.
function QueryGrounding({ queries }: { queries: { seed_source: SeedSource }[] }) {
  if (queries.length === 0) return null;
  const r = llmExpandRatio(queries);
  const grounded = r.total - r.llm_expand;
  const breakdown = seedSourceBreakdown(queries);
  const parts = (Object.keys(SEED_LABELS) as SeedSource[])
    .filter((k) => breakdown[k] > 0)
    .map((k) => `${SEED_LABELS[k]} ${breakdown[k]}`);
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.5 }}>
        {grounded} of {r.total} grounded in real buyer data
        {parts.length ? ` · ${parts.join(" · ")}` : ""}
      </div>
      {r.tooHigh && (
        <div
          role="status"
          style={{
            fontSize: 11,
            color: "#B45309",
            background: "#FFFBEB",
            border: "1px solid #FDE68A",
            borderRadius: 6,
            padding: "8px 10px",
            marginTop: 6,
            lineHeight: 1.5,
          }}
        >
          Most of these are AI-expanded, not yet grounded in real buyer data.
          Treat them as candidates to verify.
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        {htmlFor ? (
          <label htmlFor={htmlFor}>
            <Label>{label}</Label>
          </label>
        ) : (
          <Label>{label}</Label>
        )}
      </div>
      {children}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        background: T.subtle,
        border: `1px solid ${T.divider}`,
        borderRadius: 6,
        padding: "12px 14px",
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: ".06em",
          textTransform: "uppercase",
          color: T.label,
          marginBottom: 5,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 13, fontWeight: 500, color: T.ink }}>{value}</div>
    </div>
  );
}

function DoneChip() {
  return <span style={doneChipStyle}>✓ Done</span>;
}

function StepCard({
  n,
  title,
  active,
  children,
  headerExtra,
}: {
  n: string;
  title: string;
  active?: boolean;
  children: ReactNode;
  headerExtra?: ReactNode;
}) {
  return (
    <div
      data-step={n}
      style={{
        background: T.card,
        border: `1px solid ${T.border}`,
        borderLeft: `3px solid ${active ? T.green : T.border}`,
        borderRadius: 8,
        overflow: "hidden",
        animation: "step-in .3s ease-out forwards",
      }}
    >
      <div
        style={{
          padding: "18px 28px",
          borderBottom: `1px solid ${T.divider}`,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: "#fff",
            background: T.dark,
            padding: "3px 8px",
            borderRadius: 4,
          }}
        >
          {n}
        </span>
        <span style={{ fontSize: 15, fontWeight: 600, color: T.ink }}>
          {title}
        </span>
        {headerExtra}
      </div>
      <div style={{ padding: "24px 28px" }}>{children}</div>
    </div>
  );
}

function DoneBar({
  n,
  title,
  summary,
  onEdit,
  label,
}: {
  n: string;
  title: string;
  summary: string;
  onEdit: () => void;
  label: string;
}) {
  return (
    <div
      style={{
        background: T.card,
        border: `1px solid ${T.border}`,
        borderLeft: `3px solid ${T.green2}`,
        borderRadius: 8,
        padding: "14px 24px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        animation: "step-in .3s ease-out forwards",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flex: 1,
          minWidth: 0,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: "#fff",
            background: T.green2,
            padding: "3px 8px",
            borderRadius: 4,
            flexShrink: 0,
          }}
        >
          ✓ {n}
        </span>
        <span
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: T.ink,
            flexShrink: 0,
          }}
        >
          {title}
        </span>
        <span
          style={{
            fontSize: 13,
            color: T.muted,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {summary}
        </span>
      </div>
      <button
        onClick={onEdit}
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: T.green,
          cursor: "pointer",
          padding: "4px 12px",
          border: `1px solid ${T.greenBorder}`,
          borderRadius: 4,
          background: T.greenBg,
          flexShrink: 0,
          marginLeft: 12,
          fontFamily: FONT,
        }}
      >
        {label}
      </button>
    </div>
  );
}

function LockedBar({ n, title }: { n: string; title: string }) {
  return (
    <div
      style={{
        background: "#FAFAFA",
        border: `1px solid ${T.border}`,
        borderLeft: `3px solid ${T.border}`,
        borderRadius: 8,
        padding: "14px 24px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        opacity: 0.45,
      }}
    >
      <span
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: T.label,
          background: T.divider,
          padding: "3px 8px",
          borderRadius: 4,
        }}
      >
        {n}
      </span>
      <span style={{ fontSize: 14, fontWeight: 500, color: T.label }}>
        {title}
      </span>
    </div>
  );
}

function PendingNote({ text }: { text: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "20px 0",
        color: T.muted,
        fontSize: 14,
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: T.green,
          animation: "pulse-dot 1.4s ease-in-out infinite",
        }}
      />
      {text}
    </div>
  );
}

function BigNumberCard({
  kind,
  domain,
  count,
  total,
  rate,
  ci,
}: {
  kind: "you" | "competitor";
  domain: string;
  count: number;
  total: number;
  rate: number;
  ci?: { low: number; high: number };
}) {
  const you = kind === "you";
  return (
    <div
      style={{
        border: `2px solid ${you ? T.greenBorder : T.redBorder}`,
        borderRadius: 8,
        padding: 20,
        background: you ? T.greenBg2 : T.redBg,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: ".06em",
          textTransform: "uppercase",
          color: you ? T.green : T.red,
          marginBottom: 10,
        }}
      >
        {domain} · {you ? "you" : "competitor"}
      </div>
      <div
        style={{
          fontSize: 72,
          fontWeight: 800,
          color: you ? T.greenDark : T.redDark,
          lineHeight: 1,
          letterSpacing: "-.04em",
        }}
      >
        {count}
      </div>
      <div
        style={{
          fontSize: 13,
          color: you ? T.green2 : "#EF4444",
          marginTop: 6,
        }}
      >
        out of {total || "—"} queries
      </div>
      <div
        style={{
          fontSize: 20,
          fontWeight: 700,
          color: you ? T.greenDark : T.redDark,
          marginTop: 6,
        }}
      >
        {pct(rate)}{" "}
        <span
          style={{
            fontSize: 13,
            fontWeight: 400,
            color: you ? "#34D399" : "#FCA5A5",
          }}
        >
          cited
        </span>
      </div>
      {/* Uncertainty: show the CI range only when the rolled-up aggregate rows
          carry one for this domain — never fabricate a range. */}
      {ci && (
        <div
          style={{
            fontSize: 11,
            color: you ? "#059669" : "#DC2626",
            marginTop: 2,
          }}
        >
          Range: {Math.round(ci.low * 100)}–{Math.round(ci.high * 100)}%
        </div>
      )}
    </div>
  );
}

// A horizontal sliding ticker of the actual buyer questions being measured —
// makes the live sweep feel real ("here are the real questions we're running").
// Content is duplicated so the -50% loop is seamless; hover pauses; the global
// reduced-motion rule freezes it (queries stay readable, just not scrolling).
function QueryTicker({ queries }: { queries: { _id: string; text: string }[] }) {
  if (queries.length === 0) return null;
  const chip = (q: { _id: string; text: string }, dup: boolean) => (
    <span
      key={q._id + (dup ? "-d" : "")}
      aria-hidden={dup || undefined}
      style={{
        fontSize: 12,
        color: T.ink2,
        background: T.subtle,
        border: `1px solid ${T.divider}`,
        borderRadius: 20,
        padding: "5px 12px",
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        flexShrink: 0,
      }}
    >
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: "50%",
          background: T.green,
          flexShrink: 0,
        }}
      />
      “{q.text}”
    </span>
  );
  return (
    <div className="rdr-ticker">
      <div className="rdr-ticker-track">
        {queries.map((q) => chip(q, false))}
        {queries.map((q) => chip(q, true))}
      </div>
    </div>
  );
}

function LeaderRowView({
  rank,
  row,
  max,
  isTopCompetitor,
}: {
  rank: string;
  row: LeaderRow;
  max: number;
  isTopCompetitor?: boolean;
}) {
  const width = Math.min(100, max > 0 ? (row.rate / max) * 100 : 0);
  // #1 non-you competitor gets the reference's red treatment; other non-you
  // rows stay gray.
  const rowBg = row.you ? T.greenBg2 : isTopCompetitor ? T.redBg : "transparent";
  const barColor = row.you ? T.green : isTopCompetitor ? "#EF4444" : "#9CA3AF";
  const rankColor = row.you ? T.green : isTopCompetitor ? T.redDark : T.muted;
  const valueColor = rankColor;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 14px",
        background: rowBg,
        borderBottom: `1px solid ${T.divider}`,
      }}
    >
      <span
        style={{
          fontSize: 12,
          fontWeight: 700,
          color: rankColor,
          minWidth: 16,
        }}
      >
        {rank}
      </span>
      <span
        style={{
          fontSize: 13,
          fontWeight: row.you ? 600 : 500,
          color: row.you ? T.greenDark : T.ink2,
          flex: 1,
        }}
      >
        {row.domain}
        {row.you ? " (you)" : ""}
      </span>
      <div
        style={{
          flex: 2,
          height: 6,
          background: row.you ? T.greenBorder2 : T.divider,
          borderRadius: 3,
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            height: 6,
            background: barColor,
            borderRadius: 3,
            width: `${width}%`,
          }}
        />
      </div>
      <span
        style={{
          fontSize: 13,
          fontWeight: 700,
          color: valueColor,
          minWidth: 36,
          textAlign: "right",
        }}
      >
        {pct(row.rate)}
      </span>
    </div>
  );
}

function EngineBox({
  engine,
  label,
  gut,
  youCI,
}: {
  engine: string;
  label: string;
  gut: { perEngine: PerEngine } | undefined;
  youCI?: { p: number; low: number; high: number };
}) {
  const e = gut?.perEngine?.[engine];
  const comp = e?.topCompetitor ?? null;
  // Per-engine is exactly where single-draw non-determinism bites, so never a
  // bare rate without uncertainty: show the CI'd rate when an aggregate exists,
  // else an honest raw tally (cited / total) rather than a precise-looking %.
  const youText = !e
    ? "—"
    : youCI
      ? formatPcitedCI(youCI.p, youCI.low, youCI.high)
      : score(e.you);
  const compText = comp ? score(comp) : "—";
  return (
    <div
      style={{
        border: `1px solid ${T.divider}`,
        borderRadius: 6,
        padding: 12,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: T.ink2,
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 11, color: T.muted, marginBottom: 2 }}>
        You: <strong style={{ color: T.greenDark }}>{youText}</strong>
      </div>
      <div style={{ fontSize: 11, color: T.muted }}>
        Competitor: <strong style={{ color: T.redDark }}>{compText}</strong>
      </div>
    </div>
  );
}

function citedSourcesText(
  gut: { perEngine: PerEngine } | undefined,
): string {
  if (!gut) return "";
  const set = new Set<string>();
  for (const e of Object.values(gut.perEngine))
    for (const s of e.citedSources) set.add(s);
  return [...set].slice(0, 6).join(" · ");
}

function SignalRow({ coef, rank }: { coef: Coefficient; rank: number }) {
  const labelText = FEATURE_LABELS[coef.feature] ?? coef.feature;
  const why = FEATURE_WHY[coef.feature];
  const strength =
    rank === 1 ? "Strong signal" : rank === 2 ? "Signal" : "Possible";
  const strengthGreen = rank <= 2;
  const negative = coef.posterior_median < 0;
  const width = Math.min(100, (Math.abs(coef.posterior_median) / 1.5) * 100);
  // A surviving coefficient can be negative (its CI just must not cross zero); a
  // full-magnitude GREEN bar would read as a positive correlation. Color negative
  // effects distinctly so the direction of the effect is never misrepresented.
  const barColor = negative ? T.red : rank <= 2 ? T.green : "#9CA3AF";
  return (
    <div style={{ padding: "18px 0", borderBottom: `1px solid ${T.divider}` }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 14,
          marginBottom: 10,
        }}
      >
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            background: T.greenBg,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 700, color: T.green }}>
            {rank}
          </span>
        </div>
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: T.ink,
              marginBottom: 3,
            }}
          >
            {labelText}
          </div>
          {why && (
            <div style={{ fontSize: 13, color: T.muted, lineHeight: 1.5 }}>
              {why}
            </div>
          )}
        </div>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: strengthGreen ? T.green : T.muted,
            background: strengthGreen ? T.greenBg : T.divider,
            padding: "3px 10px",
            borderRadius: 20,
            flexShrink: 0,
            whiteSpace: "nowrap",
          }}
        >
          {strength}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          paddingLeft: 42,
        }}
      >
        <div
          style={{
            flex: 1,
            height: 6,
            background: T.divider,
            borderRadius: 3,
            position: "relative",
          }}
        >
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              height: 6,
              background: barColor,
              borderRadius: 3,
              width: `${width}%`,
            }}
          />
        </div>
        <span style={{ fontSize: 11, color: T.muted, minWidth: 150 }}>
          {coef.posterior_median >= 0 ? "+" : ""}
          {coef.posterior_median.toFixed(2)} · CI {coef.ci_low.toFixed(2)}–
          {coef.ci_high.toFixed(2)}
        </span>
      </div>
    </div>
  );
}

function NoiseRow({ coef }: { coef: Coefficient }) {
  const labelText = FEATURE_LABELS[coef.feature] ?? coef.feature;
  // Never reuse FEATURE_WHY here — its positive endorsements ("AI heavily cites
  // these") would directly contradict the "Not a signal" verdict on a noise row.
  const why =
    FEATURE_WHY_NOISE[coef.feature] ??
    "Not distinguishable from noise: its confidence interval crosses zero.";
  return (
    <div style={{ padding: "14px 0", opacity: 0.4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            background: T.subtle,
            border: `1px solid ${T.border}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 14, color: "#D1D5DB" }}>—</span>
        </div>
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 500,
              color: T.label,
              textDecoration: "line-through",
            }}
          >
            {labelText}
          </div>
          <div style={{ fontSize: 13, color: T.label }}>{why}</div>
        </div>
        <span
          style={{
            fontSize: 11,
            color: T.label,
            border: `1px solid ${T.border}`,
            padding: "3px 10px",
            borderRadius: 20,
            flexShrink: 0,
            whiteSpace: "nowrap",
          }}
        >
          Not a signal
        </span>
      </div>
    </div>
  );
}

interface GeneratedBrief {
  headline: string;
  subhead: string;
  points: string[];
}

function StepFiveDark({
  brief,
  ownName,
  competitorName,
  category,
  currentRate,
  topSignalLabel,
  topSignalFeature,
  signalCoef,
  onBuild,
}: {
  brief: GeneratedBrief | null;
  ownName: string;
  competitorName: string;
  category?: string;
  currentRate: number | null;
  topSignalLabel: string;
  topSignalFeature?: string;
  signalCoef?: { posterior_median: number; ci_low: number; ci_high: number };
  onBuild: () => void;
}) {
  // The deliverable is a comparison page; only claim it IS the strongest signal
  // when the measured top signal actually matches it.
  const isComparisonSignal =
    !topSignalFeature || topSignalFeature === "comparison_table";
  // Honest lift-report line: anchor on the founder's REAL current rate, never an
  // invented "4% → 18%". We don't predict the post number (the experiment measures
  // it), so we pose it as the question the report answers.
  const ratePct =
    currentRate === null ? null : `${Math.round(currentRate * 100)}%`;
  const liftSub = ratePct
    ? `Did your citation rate move from its current ${ratePct}? Or: "It didn't move. Here's what to try next."`
    : `Did your citation rate go up? Or: "It didn't move. Here's what to try next."`;
  const steps = [
    {
      active: true,
      title: "You publish the comparison page",
      sub: "One-click to WordPress, Webflow, or Contentful",
    },
    {
      active: false,
      title: "We wait 4–6 weeks",
      sub: "Enough time for AI engines to discover and index your new page",
    },
    {
      active: false,
      title: "We automatically re-run the measurement",
      sub: "Same questions, same AI engines: fair comparison",
    },
    {
      active: false,
      title: "You get a causal lift report",
      sub: liftSub,
    },
  ];
  return (
    <div
      data-step="5"
      style={{
        background: T.dark,
        borderRadius: 8,
        overflow: "hidden",
        animation: "step-in .4s ease-out forwards",
      }}
    >
      <div
        style={{
          padding: "18px 28px",
          borderBottom: "1px solid #1F2937",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: T.dark,
            background: T.subtle,
            padding: "3px 8px",
            borderRadius: 4,
          }}
        >
          05
        </span>
        <span style={{ fontSize: 15, fontWeight: 600, color: T.subtle }}>
          Your next move
        </span>
      </div>
      <div style={{ padding: "24px 28px" }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: ".06em",
            textTransform: "uppercase",
            color: T.muted,
            marginBottom: 12,
          }}
        >
          What we'll build for you
        </div>
        <div
          style={{
            background: "#1F2937",
            border: "1px solid #374151",
            borderRadius: 6,
            padding: "16px 18px",
            marginBottom: 24,
          }}
        >
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: T.subtle,
              marginBottom: 6,
            }}
          >
            {/* AI-generated, company-specific headline when available; otherwise a
                data-derived "you vs competitor" title. */}
            {brief
              ? brief.headline
              : `${ownName} vs ${competitorName}${category ? `: your comparison page for ${category}` : ""}`}
          </div>
          <div style={{ fontSize: 13, color: T.label, lineHeight: 1.6 }}>
            {brief
              ? brief.subhead
              : `Generated from your scan, structured the way AI engines cite: a direct answer first, a ${ownName}-vs-${competitorName} feature table, and an honest take on when to choose each.`}
          </div>
          {!brief && (
            <div
              style={{
                fontSize: 12,
                color: T.muted,
                lineHeight: 1.6,
                marginTop: 8,
              }}
            >
              {isComparisonSignal
                ? `Built to close your strongest measured gap: ${topSignalLabel.toLowerCase()}`
                : `Your strongest measured signal is ${topSignalLabel.toLowerCase()}. We start with a comparison page because it's the quickest change to build and measure, then test the rest`}
              {signalCoef
                ? ` (+${signalCoef.posterior_median.toFixed(2)} · CI ${signalCoef.ci_low.toFixed(2)}–${signalCoef.ci_high.toFixed(2)}).`
                : "."}
            </div>
          )}
          <div
            style={{
              display: "flex",
              gap: 8,
              marginTop: 10,
              flexWrap: "wrap",
            }}
          >
            {(brief && brief.points.length
              ? brief.points
              : [topSignalLabel, "Direct answer first", "Comparison table"]
            )
              .filter(Boolean)
              .map((t) => (
                <span
                  key={t}
                  style={{
                    fontSize: 11,
                    fontWeight: 500,
                    color: T.label,
                    background: "#374151",
                    padding: "3px 10px",
                    borderRadius: 20,
                  }}
                >
                  {t}
                </span>
              ))}
          </div>
        </div>

        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: ".06em",
            textTransform: "uppercase",
            color: T.muted,
            marginBottom: 12,
          }}
        >
          What happens after you publish
        </div>
        <div style={{ display: "flex", flexDirection: "column", marginBottom: 24 }}>
          {steps.map((s, i) => (
            <div
              key={i}
              style={{ display: "flex", gap: 14, alignItems: "flex-start" }}
            >
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                }}
              >
                <div
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: "50%",
                    background: s.active ? T.green : "#374151",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      color: s.active ? "#fff" : T.label,
                    }}
                  >
                    {i + 1}
                  </span>
                </div>
                {i < steps.length - 1 && (
                  <div
                    style={{
                      width: 1,
                      flex: 1,
                      minHeight: 16,
                      background: "#374151",
                      margin: "4px 0",
                    }}
                  />
                )}
              </div>
              <div style={{ paddingBottom: 14 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: s.active ? T.subtle : T.label,
                  }}
                >
                  {s.title}
                </div>
                <div style={{ fontSize: 12, color: T.muted, marginTop: 2 }}>
                  {s.sub}
                </div>
              </div>
            </div>
          ))}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            flexWrap: "wrap",
          }}
        >
          <button
            onClick={onBuild}
            style={{ ...greenButton, fontWeight: 700, fontSize: 14, padding: "13px 32px" }}
          >
            Build the comparison page
          </button>
          <div style={{ fontSize: 13, color: T.muted }}>
            Then we'll measure whether it worked.
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SCREEN 2 — Asset page
// ─────────────────────────────────────────────────────────────────────────────
function AssetScreen({
  workspaceId,
  navigate,
}: {
  workspaceId?: Id<"workspaces">;
  navigate: (r: Route) => void;
}) {
  const skip = "skip" as const;
  const battlefield =
    useQuery(api.board.battlefield, workspaceId ? { workspaceId } : skip) ?? [];
  const queries =
    useQuery(api.board.queries, workspaceId ? { workspaceId } : skip) ?? [];
  const pages =
    useQuery(api.board.pages, workspaceId ? { workspaceId } : skip) ?? [];
  const measurements =
    useQuery(api.board.measurements, workspaceId ? { workspaceId } : skip) ?? [];
  const gut = useQuery(
    api.board.gutPunch,
    workspaceId ? { workspaceId } : skip,
  );
  const diagnosis = useQuery(
    api.board.diagnosis,
    workspaceId ? { workspaceId } : skip,
  );
  const assetBrief = useQuery(
    api.board.assetBrief,
    workspaceId ? { workspaceId } : skip,
  );
  const customer = battlefield.find((c) => c.role === "customer");
  // Only run host() on an actual domain — never on the literal fallback words
  // (host() URL-encodes spaces → "your%20company"). Show a human-readable name
  // when customer/competitor data is absent.
  const ownName =
    customer?.name ?? (customer?.domain ? host(customer.domain) : "Your company");
  // Prefer the founder's explicitly-typed competitor over an auto-discovered
  // battlefield row, so the head-to-head names a meaningful target rather than
  // the first non-customer company by creation order.
  const competitor =
    battlefield.find((c) => c.role === "competitor") ??
    battlefield.find((c) => c.role !== "customer");
  const competitorName =
    competitor?.name ??
    (competitor?.domain ? host(competitor.domain) : "your top competitor");

  const fit = diagnosis?.modelFits?.[0];
  const queryCoverage = queries.length;

  const u = customer?.understanding;
  const gaps = fit ? rankedGaps(fit.coefficients as Coefficient[]) : null;
  const topCoef = gaps?.surviving[0];
  const topSignalLabel = topCoef
    ? FEATURE_LABELS[topCoef.feature] ?? topCoef.feature
    : "a comparison page";

  // The actionable insight: the SPECIFIC buyer questions where a competitor got
  // referenced and you didn't. Join measurements (cited per query×page) against the
  // own/competitor domains — these exact questions are where you're losing, and what
  // the generated page is built to win back.
  const ownDom = (gut as any)?.own_domain as string | undefined;
  const compSet = new Set(
    battlefield.filter((c) => c.role !== "customer").map((c) => c.domain),
  );
  const queryText = new Map<string, string>(
    queries.map((q) => [String(q._id), q.text]),
  );
  const lossByQuery = new Map<string, { ownCited: boolean; rival?: string }>();
  for (const m of measurements as any[]) {
    const qid = String(m.query_id);
    const dom = host(m.page_url);
    const rec = lossByQuery.get(qid) ?? { ownCited: false };
    if (ownDom && dom === ownDom) {
      if (m.cited) rec.ownCited = true;
    } else if (compSet.has(dom) && m.cited && !rec.rival) {
      rec.rival = dom;
    }
    lossByQuery.set(qid, rec);
  }
  const losingQueries = [...lossByQuery.entries()]
    .filter(([, v]) => v.rival && !v.ownCited)
    .map(([qid, v]) => ({ text: queryText.get(qid) ?? "", rival: v.rival! }))
    .filter((q) => q.text);

  // ── The HIDDEN insights strip — non-obvious, measured findings only the scan
  //    surfaces, in priority order. Built from whatever real data exists (not a
  //    generic page checklist), so it shows alpha when available and the live
  //    measurement facts otherwise. Each item: {kind, text, tag?}.
  const scanInsights: Array<{ kind: "up" | "flat" | "src"; text: string; tag?: string }> = [];
  // 1. Proven measured lifts (the alpha) — strongest, from completed experiments.
  for (const r of assetBrief?.recommendations ?? []) {
    if (r.kind === "measured")
      scanInsights.push({ kind: "up", text: r.title.replace(/^Add /, ""), tag: r.evidence });
  }
  // 2. Model-fit discriminators — what separates cited pages from ignored ones.
  for (const c of gaps?.surviving.slice(0, 3) ?? [])
    scanInsights.push({
      kind: "up",
      text: FEATURE_LABELS[c.feature] ?? c.feature,
      tag: `+${c.posterior_median.toFixed(2)}`,
    });
  // 3. The counterintuitive non-signal (a feature people assume matters, that doesn't).
  if (gaps?.noise[0])
    scanInsights.push({
      kind: "flat",
      text: FEATURE_LABELS[gaps.noise[0].feature] ?? gaps.noise[0].feature,
      tag: "no effect here",
    });
  // 4. The measured citation gap — who AI actually cites, you vs your rival.
  const ge = (gut as any)?.perEngine?.openai;
  if (ge?.you && ge.topCompetitor) {
    const you = ge.you.cited;
    const them = ge.topCompetitor.cited;
    if (them > you)
      scanInsights.push({
        kind: "src",
        text: `${competitorName} cited ${them}/${ge.topCompetitor.total} · you ${you}/${ge.you.total}`,
      });
  }
  // 5. How many of your buyer questions a rival wins outright.
  if (losingQueries.length > 0 && queries.length > 0)
    scanInsights.push({
      kind: "up",
      text: `Losing ${losingQueries.length} of ${queries.length} questions to rivals`,
    });
  // 6. Where AI cites the rivals FROM (reddit, g2, …) — you can't see this from your
  //    page. Trimmed to the first few sources to keep the chip readable.
  const citedFrom = citedSourcesText(gut as any)
    .split(" · ")
    .slice(0, 3)
    .join(", ");
  if (citedFrom)
    scanInsights.push({ kind: "src", text: `Cited from ${citedFrom}` });
  // 7. The size of the competitive field we measured you against.
  if (compSet.size > 0)
    scanInsights.push({
      kind: "src",
      text: `${compSet.size} rivals measured in your space`,
    });

  // The page's lead sentence is built from the founder's OWN analyzed positioning
  // (what they do, who they sell to, their angle), never invented facts.
  const daParts: string[] = [];
  if (u?.what_you_are) daParts.push(`${ownName}: ${u.what_you_are}`);
  else daParts.push(`${ownName} and ${competitorName}, compared head to head.`);
  if (u?.icp) daParts.push(`It's built for ${u.icp}.`);
  if (u?.positioning) {
    const p = u.positioning.trim();
    daParts.push(/[.!?]$/.test(p) ? p : `${p}.`);
  }
  daParts.push(
    `This page is structured to answer how buyers weigh ${ownName} against ${competitorName} in AI search.`,
  );
  const directAnswer = daParts.join(" ");

  // Time-box the loading gate so the founder is never hard-blocked behind a
  // customer row that may never land (pipeline failure, or a deep-link opened
  // before buildBattlefield writes the company).
  const loadSecs = useElapsedSeconds(!!workspaceId && !customer);

  // Never render a preset/demo company. With no workspace, send the founder to
  // the scan; while their site is still being analyzed, show a "preparing" state
  // rather than placeholder company names — and after a grace period, a way back.
  if (!workspaceId) return <AssetGate navigate={navigate} mode="none" />;
  if (!customer)
    return (
      <AssetGate
        navigate={navigate}
        mode={loadSecs >= 8 ? "stalled" : "loading"}
        workspaceId={workspaceId}
      />
    );

  return (
    <div style={{ minHeight: "100vh", background: T.pageBg }}>
      <Nav>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <RadarBrand onClick={() => navigate({ screen: "wizard" })} />
          <span style={{ color: T.border }}>|</span>
          <button
            style={navLink}
            onClick={() => navigate({ screen: "wizard", workspaceId })}
          >
            ← Back to analysis
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ fontSize: 13, color: T.muted }}>
            {customer?.domain ?? ""}
          </div>
        </div>
      </Nav>

      {/* control bar */}
      <div
        className="rdr-padx"
        style={{
          background: T.card,
          borderBottom: `1px solid ${T.border}`,
          padding: "14px 48px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: ".06em",
                textTransform: "uppercase",
                color: "#fff",
                background: T.green2,
                padding: "3px 10px",
                borderRadius: 4,
              }}
            >
              Generated
            </span>
            <span style={{ fontSize: 14, fontWeight: 600, color: T.ink }}>
              {ownName} vs {competitorName}
            </span>
          </div>
          <span style={{ color: T.border, fontSize: 16 }}>·</span>
          <span style={{ fontSize: 13, color: T.muted }}>
            Targeting: {topSignalLabel}
            {topCoef
              ? ` · signal +${topCoef.posterior_median.toFixed(2)}`
              : ""}
          </span>
          {queryCoverage > 0 && (
            <>
              <span style={{ color: T.border, fontSize: 16 }}>·</span>
              <span style={{ fontSize: 13, color: T.muted }}>
                Optimized for {queryCoverage} buyer queries
              </span>
            </>
          )}
        </div>
      </div>

      {/* AI signal strip */}
      <div
        className="rdr-padx"
        style={{
          background: T.greenBg,
          borderBottom: `1px solid ${T.greenBorder}`,
          padding: "10px 48px",
          display: "flex",
          alignItems: "center",
          gap: 20,
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: ".06em",
            textTransform: "uppercase",
            color: T.greenDark,
            flexShrink: 0,
          }}
        >
          What your scan surfaced
        </span>
        {/* The HIDDEN insights — measured, non-obvious findings only the scan
            surfaces (alpha, discriminators, the citation gap, where rivals are
            cited from), NOT a generic page checklist. */}
        {scanInsights.length > 0 ? (
          scanInsights
            .slice(0, 6)
            .map((s, i) => (
              <ScanInsight key={i} kind={s.kind} text={s.text} tag={s.tag} />
            ))
        ) : (
          <span style={{ fontSize: 12, color: T.greenDark }}>
            Measuring which signals separate cited pages from ignored ones…
          </span>
        )}
      </div>

      {/* page content */}
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "48px 32px 80px" }}>
        <div
          style={{
            background: T.card,
            border: `1px solid ${T.border}`,
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          {/* header + direct answer — built from the founder's own site analysis */}
          <div
            style={{
              padding: "40px 48px 32px",
              borderBottom: `1px solid ${T.divider}`,
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: ".08em",
                textTransform: "uppercase",
                color: T.label,
                marginBottom: 12,
              }}
            >
              Comparison · {u?.category ?? "your category"}
            </div>
            <div
              style={{
                fontSize: 28,
                fontWeight: 800,
                color: T.ink,
                lineHeight: 1.25,
                letterSpacing: "-.02em",
                marginBottom: 16,
              }}
            >
              {ownName} vs {competitorName}
            </div>
            <div style={{ position: "relative" }}>
              <div
                style={{
                  position: "absolute",
                  left: -20,
                  top: 0,
                  bottom: 0,
                  width: 3,
                  background: T.green,
                  borderRadius: 2,
                }}
              />
              <div
                style={{
                  background: T.greenBg2,
                  border: `1px solid ${T.greenBorder2}`,
                  borderRadius: 6,
                  padding: "16px 18px",
                  marginBottom: 4,
                }}
              >
                <div
                  style={{
                    fontSize: 14,
                    color: T.ink2,
                    lineHeight: 1.7,
                    fontWeight: 500,
                  }}
                >
                  {directAnswer}
                </div>
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: T.green,
                  fontWeight: 600,
                  letterSpacing: ".04em",
                  paddingLeft: 2,
                }}
              >
                ↑ Direct answer first: AI engines cite this sentence
              </div>
            </div>
          </div>

          {/* what your site told us — the real analysis */}
          {u && (u.category || u.icp || u.positioning) && (
            <div
              className="rdr-grid-3"
              style={{
                padding: "24px 48px",
                borderBottom: `1px solid ${T.divider}`,
                gap: 10,
              }}
            >
              <MiniStat label="Category" value={u.category || "—"} />
              <MiniStat label="Who you sell to" value={u.icp || "—"} />
              <MiniStat label="Your angle" value={u.positioning || "—"} />
            </div>
          )}

          {/* why this page wins citations — the real gap it closes */}
          <div
            style={{
              padding: "32px 48px",
              borderBottom: `1px solid ${T.divider}`,
            }}
          >
            <div
              style={{
                fontSize: 16,
                fontWeight: 700,
                color: T.ink,
                letterSpacing: "-.01em",
                marginBottom: 6,
              }}
            >
              Built to close your biggest gap
            </div>
            <div style={{ fontSize: 13, color: T.muted, marginBottom: 16 }}>
              Generated from your site to target the pattern most correlated with
              getting cited in {u?.category ?? "your category"}.
            </div>
            {topCoef ? (
              <div
                style={{
                  border: `1px solid ${T.divider}`,
                  borderRadius: 6,
                  padding: "16px 18px",
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 14,
                }}
              >
                <div
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 6,
                    background: T.greenBg,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <span
                    style={{ fontSize: 12, fontWeight: 700, color: T.green }}
                  >
                    1
                  </span>
                </div>
                <div style={{ flex: 1 }}>
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: 600,
                      color: T.ink,
                      marginBottom: 3,
                    }}
                  >
                    {topSignalLabel}
                  </div>
                  <div
                    style={{ fontSize: 13, color: T.muted, lineHeight: 1.5 }}
                  >
                    {FEATURE_WHY[topCoef.feature] ??
                      "Correlates with getting cited in your category. Worth testing."}
                  </div>
                </div>
                <span
                  style={{
                    fontSize: 11,
                    color: T.muted,
                    whiteSpace: "nowrap",
                    marginTop: 3,
                  }}
                >
                  +{topCoef.posterior_median.toFixed(2)} · CI{" "}
                  {topCoef.ci_low.toFixed(2)}–{topCoef.ci_high.toFixed(2)}
                </span>
              </div>
            ) : (
              <div style={{ fontSize: 13, color: T.muted }}>
                Analyzing which patterns drive citations in your category…
              </div>
            )}
          </div>

          {/* what to change to get cited — AI-generated, honest hypotheses */}
          {assetBrief?.recommendations && assetBrief.recommendations.length > 0 && (
            <div
              style={{
                padding: "32px 48px",
                borderBottom: `1px solid ${T.divider}`,
              }}
            >
              <div
                style={{
                  fontSize: 16,
                  fontWeight: 700,
                  color: T.ink,
                  letterSpacing: "-.01em",
                  marginBottom: 6,
                }}
              >
                What to change to get cited
              </div>
              <div style={{ fontSize: 13, color: T.muted, marginBottom: 16 }}>
                {assetBrief.recommendations.some((r) => r.kind === "measured")
                  ? "Ranked by what we've actually measured in your category. Measured changes are backed by completed experiments; the rest are hypotheses worth testing."
                  : "Specific changes worth testing, generated from your scan. These correlate with getting cited, they're not guarantees."}
              </div>
              <div
                style={{ display: "flex", flexDirection: "column", gap: 10 }}
              >
                {assetBrief.recommendations.map((r, i) => {
                  const measured = r.kind === "measured";
                  return (
                    <div
                      key={i}
                      style={{
                        display: "flex",
                        gap: 14,
                        alignItems: "flex-start",
                        border: `1px solid ${measured ? T.greenBorder : T.divider}`,
                        background: measured ? T.greenBg2 : "transparent",
                        borderRadius: 6,
                        padding: "14px 16px",
                      }}
                    >
                      <div
                        style={{
                          width: 24,
                          height: 24,
                          borderRadius: 6,
                          background: T.greenBg,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          flexShrink: 0,
                        }}
                      >
                        <span
                          style={{ fontSize: 12, fontWeight: 700, color: T.green }}
                        >
                          {i + 1}
                        </span>
                      </div>
                      <div style={{ flex: 1 }}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            marginBottom: 2,
                            flexWrap: "wrap",
                          }}
                        >
                          <span
                            style={{ fontSize: 14, fontWeight: 600, color: T.ink }}
                          >
                            {r.title}
                          </span>
                          <span
                            style={{
                              fontSize: 10,
                              fontWeight: 700,
                              letterSpacing: ".04em",
                              textTransform: "uppercase",
                              padding: "2px 7px",
                              borderRadius: 4,
                              color: measured ? "#fff" : T.muted,
                              background: measured ? T.green : T.divider,
                            }}
                          >
                            {measured ? "✓ Measured" : "To test"}
                          </span>
                        </div>
                        <div
                          style={{ fontSize: 13, color: T.muted, lineHeight: 1.5 }}
                        >
                          {r.detail}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* the actionable hidden insight: the exact questions you're losing */}
          {losingQueries.length > 0 && (
            <div
              style={{
                padding: "32px 48px",
                borderBottom: `1px solid ${T.divider}`,
              }}
            >
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 700,
                  color: T.ink,
                  marginBottom: 6,
                }}
              >
                Questions {competitorName} is cited for, and you're not
              </div>
              <div style={{ fontSize: 13, color: T.muted, marginBottom: 16 }}>
                On these exact buyer questions, AI referenced your competitor and
                skipped you. This page is built to win them back.
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {losingQueries.slice(0, 8).map((q, i) => (
                  <span
                    key={i}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 8,
                      fontSize: 12,
                      color: T.ink2,
                      background: T.redBg,
                      border: `1px solid ${T.redBorder}`,
                      borderRadius: 20,
                      padding: "6px 12px",
                    }}
                  >
                    <span
                      style={{
                        width: 5,
                        height: 5,
                        borderRadius: "50%",
                        background: T.red,
                        flexShrink: 0,
                      }}
                    />
                    “{q.text}”
                  </span>
                ))}
                {losingQueries.length > 8 && (
                  <span style={{ fontSize: 12, color: T.muted, padding: "6px 0" }}>
                    + {losingQueries.length - 8} more
                  </span>
                )}
              </div>
            </div>
          )}

          {/* the real buyer questions this page answers */}
          <div style={{ padding: "32px 48px" }}>
            <div
              style={{
                fontSize: 15,
                fontWeight: 700,
                color: T.ink,
                marginBottom: 6,
              }}
            >
              The buyer questions this page answers
            </div>
            <div style={{ fontSize: 13, color: T.muted, marginBottom: 16 }}>
              The real questions buyers in your space ask AI, pulled from your
              scan.
            </div>
            {queries.length > 0 ? (
              <>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {queries.slice(0, 8).map((q) => (
                    <span
                      key={q._id}
                      style={{
                        fontSize: 12,
                        color: T.ink2,
                        background: T.subtle,
                        border: `1px solid ${T.divider}`,
                        padding: "6px 12px",
                        borderRadius: 20,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      “{q.text}”
                      <SeedTag source={q.seed_source} />
                    </span>
                  ))}
                  {queries.length > 8 && (
                    <span
                      style={{ fontSize: 12, color: T.muted, padding: "6px 0" }}
                    >
                      + {queries.length - 8} more
                    </span>
                  )}
                </div>
                <QueryGrounding queries={queries} />
              </>
            ) : (
              <div style={{ fontSize: 13, color: T.muted }}>
                Generating buyer questions from your site…
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}

// Shown instead of a preset/demo company: either "no scan yet" (send to the
// wizard) or "still analyzing your site" while the founder's company row is
// being written by the pipeline.
function AssetGate({
  navigate,
  mode,
  workspaceId,
}: {
  navigate: (r: Route) => void;
  mode: "none" | "loading" | "stalled";
  workspaceId?: Id<"workspaces">;
}) {
  return (
    <div style={{ minHeight: "100vh", background: T.pageBg }}>
      <Nav>
        <RadarBrand onClick={() => navigate({ screen: "wizard" })} />
        <LiveBadge />
      </Nav>
      <div
        style={{
          maxWidth: 520,
          margin: "0 auto",
          padding: "96px 32px",
          textAlign: "center",
        }}
      >
        {mode === "loading" || mode === "stalled" ? (
          <>
            <div style={{ display: "flex", justifyContent: "center", gap: 6, marginBottom: 20 }}>
              {[0, 0.2, 0.4].map((d) => (
                <span
                  key={d}
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: T.green,
                    animation: "reading 1.2s ease-in-out infinite",
                    animationDelay: `${d}s`,
                  }}
                />
              ))}
            </div>
            <div
              style={{
                fontSize: 22,
                fontWeight: 800,
                color: T.ink,
                letterSpacing: "-.02em",
                marginBottom: 10,
              }}
            >
              Analyzing your site
            </div>
            <div style={{ fontSize: 15, color: T.muted, lineHeight: 1.6 }}>
              We're reading what your company does and finding the competitors
              you're up against. Your page builds itself from that, and appears
              here as soon as it's ready.
            </div>
            {mode === "stalled" && (
              <div style={{ marginTop: 24 }}>
                <div
                  style={{
                    fontSize: 13,
                    color: T.muted,
                    lineHeight: 1.6,
                    marginBottom: 16,
                  }}
                >
                  This is taking longer than usual. You can head back to your
                  scan and open the page once it's ready.
                </div>
                <button
                  onClick={() => navigate({ screen: "wizard", workspaceId })}
                  style={greenButton}
                >
                  ← Back to your scan
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <div
              style={{
                fontSize: 22,
                fontWeight: 800,
                color: T.ink,
                letterSpacing: "-.02em",
                marginBottom: 10,
              }}
            >
              No scan yet
            </div>
            <div
              style={{
                fontSize: 15,
                color: T.muted,
                lineHeight: 1.6,
                marginBottom: 24,
              }}
            >
              Enter your website first. Radar analyzes what you do, finds your
              competitors, and measures who AI engines cite, then builds this
              page from your own data.
            </div>
            <button
              onClick={() => navigate({ screen: "wizard" })}
              style={greenButton}
            >
              Start a scan
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// One measured insight from the scan, rendered as a clean pill (green dot + text,
// matching the query-ticker chips). "flat" = a counterintuitive non-signal.
function ScanInsight({
  kind,
  text,
  tag,
}: {
  kind: "up" | "flat" | "src";
  text: string;
  tag?: string;
}) {
  const flat = kind === "flat";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        fontSize: 12,
        color: flat ? T.muted : T.ink2,
        background: T.card,
        border: `1px solid ${flat ? T.border : T.greenBorder}`,
        borderRadius: 20,
        padding: "5px 12px",
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: "50%",
          background: flat ? T.label : T.green,
          flexShrink: 0,
        }}
      />
      <span style={{ textDecoration: flat ? "line-through" : "none" }}>
        {text}
      </span>
      {tag && (
        <span style={{ fontWeight: 700, color: flat ? T.muted : T.green }}>
          {tag}
        </span>
      )}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SCREEN 3 — Lift report  (gated: renders ONLY with a lift_result)
// ─────────────────────────────────────────────────────────────────────────────
function LiftScreen({
  workspaceId,
  navigate,
}: {
  workspaceId?: Id<"workspaces">;
  navigate: (r: Route) => void;
}) {
  const skip = "skip" as const;
  const diagnosis = useQuery(
    api.board.diagnosis,
    workspaceId ? { workspaceId } : skip,
  );
  const measurements =
    useQuery(api.board.measurements, workspaceId ? { workspaceId } : skip) ?? [];
  const gut = useQuery(api.board.gutPunch, workspaceId ? { workspaceId } : skip);

  const evidence = {
    hasMeasurement: measurements.length > 0,
    hasModelFit: (diagnosis?.modelFits.length ?? 0) > 0,
    hasLiftResult: diagnosis?.hasLiftResult ?? false,
  };

  const nav = (
    <Nav>
      <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
        <RadarBrand onClick={() => navigate({ screen: "wizard" })} />
        <span style={{ color: T.border }}>|</span>
        <button
          style={navLink}
          onClick={() => navigate({ screen: "wizard", workspaceId })}
        >
          ← Back to analysis
        </button>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {evidence.hasLiftResult && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: ".06em",
              textTransform: "uppercase",
              color: "#fff",
              background: T.purple,
              padding: "5px 12px",
              borderRadius: 4,
            }}
          >
            Rung 2 · Causal
          </span>
        )}
        <span style={{ fontSize: 13, color: T.muted }}>
          experiment {evidence.hasLiftResult ? "completed" : "in progress"}
        </span>
      </div>
    </Nav>
  );

  // ── Honesty gate: no lift_result → NO causal language. Show a locked state. ──
  if (!evidence.hasLiftResult) {
    return (
      <div style={{ minHeight: "100vh", background: T.pageBg }}>
        {nav}
        <div style={{ maxWidth: 720, margin: "0 auto", padding: "64px 32px" }}>
          <div
            style={{
              background: T.card,
              border: `1px solid ${T.border}`,
              borderLeft: `4px solid ${T.border}`,
              borderRadius: 8,
              padding: "36px 40px",
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: ".08em",
                textTransform: "uppercase",
                color: T.label,
                marginBottom: 12,
              }}
            >
              Experiment running · no causal result yet
            </div>
            <div
              style={{
                fontSize: 24,
                fontWeight: 800,
                color: T.ink,
                letterSpacing: "-.02em",
                lineHeight: 1.25,
                marginBottom: 12,
              }}
            >
              We can't show a lift number until the experiment completes.
            </div>
            <div style={{ fontSize: 15, color: T.muted, lineHeight: 1.6 }}>
              You published the page. Now AI engines need time to discover and
              index it. Once we re-run the same buyer questions against matched
              control pages, you'll get a causal lift report here. Until a
              measured result exists, Radar will not claim your change worked.
            </div>
            <div
              style={{
                marginTop: 24,
                padding: "16px 18px",
                background: T.subtle,
                border: `1px solid ${T.divider}`,
                borderRadius: 6,
                fontSize: 13,
                color: T.ink2,
                lineHeight: 1.6,
              }}
            >
              This is the claim ladder in action:{" "}
              <strong>measurements</strong> are descriptive,{" "}
              <strong>signals</strong> are hypotheses, and only a completed{" "}
              <strong>randomized experiment</strong> licenses a causal claim.
            </div>
            <button
              onClick={() => navigate({ screen: "wizard", workspaceId })}
              style={{ ...greenButton, marginTop: 24 }}
            >
              ← Back to your analysis
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Causal surface — a lift_result exists, so the claim is now licensed. ──
  const claim = makeClaim(RUNG.CAUSAL, evidence); // throws if misused; safe here
  const lr = diagnosis!.liftResults[0];
  const ownDomain = (gut as any)?.own_domain as string | undefined;

  const windowRate = (tag: string): { cited: number; total: number } | null => {
    // gut (own_domain) is a separate, parallel query. Until it resolves, do NOT
    // widen the filter to every row — that would briefly attribute control and
    // competitor pages to the founder and flash a wrong citation rate. Render the
    // loading "—"/"measuring…" state instead by returning null.
    if (!ownDomain) return null;
    const rows = measurements.filter(
      (r) => r.window_tag === tag && host(r.page_url) === host(ownDomain),
    );
    if (rows.length === 0) return null;
    return { cited: rows.filter((r) => r.cited).length, total: rows.length };
  };
  const before = windowRate("baseline");
  const after = windowRate("post");
  const beforeRate = before ? before.cited / before.total : null;
  const afterRate = after ? after.cited / after.total : null;

  const verdictColor =
    lr.verdict === "worked"
      ? T.green2
      : lr.verdict === "no_effect"
        ? "#9CA3AF"
        : "#D97706"; // inconclusive → amber
  const verdictHeadline =
    lr.verdict === "worked"
      ? "The comparison page worked."
      : lr.verdict === "no_effect"
        ? "The change didn't move your citation rate."
        : "The result is inconclusive.";

  const estPct = (lr.estimate * 100).toFixed(0);
  const ciLowPct = (lr.ci_low * 100).toFixed(0);
  const ciHighPct = (lr.ci_high * 100).toFixed(0);
  const pPct = (lr.p_value * 100).toFixed(1);

  // Verdict-awareness: ONLY a "worked" verdict licenses the positive framing. For
  // no_effect / inconclusive the same numbers must read neutral/amber, never as a
  // measured win.
  const worked = lr.verdict === "worked";
  const afterAccent = worked ? T.green : verdictColor;
  const ciCrossesZero = lr.ci_low <= 0 && lr.ci_high >= 0;
  // Sign each CI bound independently — a zero-crossing interval has a negative low,
  // so a hardcoded "+" would render the broken "+-12%".
  const ciLowSigned = `${lr.ci_low >= 0 ? "+" : ""}${ciLowPct}%`;
  const ciHighSigned = `${lr.ci_high >= 0 ? "+" : ""}${ciHighPct}%`;
  // The hero arrow shows the RAW descriptive delta (after − before), NOT the
  // causal DiD estimate (which is surfaced separately in the evidence stat). The
  // descriptive and causal layers must never be blurred into one number.
  const rawDeltaPp =
    beforeRate !== null && afterRate !== null
      ? Math.round((afterRate - beforeRate) * 100)
      : null;
  // "N× more" is a positive-win statement: show it ONLY when the verdict worked
  // AND the rate actually increased — never for a flat or down result.
  const relMultiple =
    worked && beforeRate && beforeRate > 0 && afterRate && afterRate > beforeRate
      ? (afterRate / beforeRate).toFixed(1)
      : null;

  // "Where AI is citing you now": real post-window cited rows on the customer's
  // own domain, grouped by page. Honest — only real cited rows, no fabrication.
  const citedPages = (() => {
    // Same race guard as windowRate: without a resolved own_domain we cannot tell
    // the founder's pages from control/competitor pages, so attribute nothing yet.
    if (!ownDomain) return [] as [string, number][];
    const m = new Map<string, number>();
    for (const r of measurements) {
      if (r.window_tag !== "post" || !r.cited) continue;
      if (host(r.page_url) !== host(ownDomain)) continue;
      m.set(r.page_url, (m.get(r.page_url) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  })();
  const postTotal = after?.total ?? null;

  // "Your next experiment": the SECOND surviving signal (the first is the one we
  // just tested) — else a generic placeholder.
  const liftFit = diagnosis?.modelFits?.[0];
  const liftGaps = liftFit
    ? rankedGaps(liftFit.coefficients as Coefficient[])
    : null;
  const nextSignal = liftGaps?.surviving?.[1];
  const nextLabel = nextSignal
    ? (FEATURE_LABELS[nextSignal.feature] ?? nextSignal.feature)
    : "your next signal";

  return (
    <div style={{ minHeight: "100vh", background: T.pageBg }}>
      {nav}
      <div
        style={{
          maxWidth: 720,
          margin: "0 auto",
          padding: "48px 32px 80px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {/* result hero */}
        <div
          style={{
            background: T.card,
            border: `1px solid ${T.border}`,
            borderLeft: `4px solid ${verdictColor}`,
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "36px 40px 32px",
              borderBottom: `1px solid ${T.divider}`,
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: ".08em",
                textTransform: "uppercase",
                color: verdictColor,
                marginBottom: 12,
              }}
            >
              Experiment result · post-publish window
            </div>
            <div
              style={{
                fontSize: 30,
                fontWeight: 800,
                color: T.ink,
                letterSpacing: "-.02em",
                lineHeight: 1.2,
                marginBottom: 8,
              }}
            >
              {verdictHeadline}
            </div>
            <div style={{ fontSize: 16, color: T.muted, lineHeight: 1.6 }}>
              Compared against matched control pages we deliberately left
              unchanged. Here's the evidence.
            </div>
          </div>

          {/* before / after */}
          <div
            style={{
              padding: "28px 40px",
              borderBottom: `1px solid ${T.divider}`,
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: ".06em",
                textTransform: "uppercase",
                color: T.label,
                marginBottom: 16,
              }}
            >
              Citation rate · same buyer queries
            </div>
            <div
              className="rdr-beforeafter"
              style={{
                alignItems: "center",
              }}
            >
              <div
                style={{
                  background: T.subtle,
                  border: `1px solid ${T.border}`,
                  borderRadius: 8,
                  padding: "20px 24px",
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: ".06em",
                    textTransform: "uppercase",
                    color: T.label,
                    marginBottom: 10,
                  }}
                >
                  Before · baseline
                </div>
                <div
                  style={{
                    fontSize: 64,
                    fontWeight: 800,
                    color: T.label,
                    lineHeight: 1,
                    letterSpacing: "-.04em",
                  }}
                >
                  {beforeRate === null ? "—" : pct(beforeRate)}
                </div>
                <div style={{ fontSize: 13, color: T.label, marginTop: 6 }}>
                  {before ? `${before.cited} / ${before.total} queries cited` : "no baseline rows"}
                </div>
              </div>

              <div className="rdr-arrow" style={{ textAlign: "center", padding: "0 24px" }}>
                <div style={{ fontSize: 24, color: afterAccent, fontWeight: 700 }}>
                  →
                </div>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: afterAccent,
                    letterSpacing: ".04em",
                    marginTop: 4,
                  }}
                >
                  {rawDeltaPp === null
                    ? "—"
                    : `${rawDeltaPp >= 0 ? "+" : ""}${rawDeltaPp}pp`}
                </div>
              </div>

              <div
                style={{
                  background: worked ? T.greenBg : T.subtle,
                  border: `2px solid ${worked ? "#6EE7B7" : verdictColor}`,
                  borderRadius: 8,
                  padding: "20px 24px",
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: ".06em",
                    textTransform: "uppercase",
                    color: afterAccent,
                    marginBottom: 10,
                  }}
                >
                  After · post-publish
                </div>
                <div
                  style={{
                    fontSize: 64,
                    fontWeight: 800,
                    color: afterAccent,
                    lineHeight: 1,
                    letterSpacing: "-.04em",
                    animation: "count-up .5s ease-out forwards",
                  }}
                >
                  {afterRate === null ? "—" : pct(afterRate)}
                </div>
                <div style={{ fontSize: 13, color: afterAccent, marginTop: 6 }}>
                  {after ? `${after.cited} / ${after.total} queries cited` : "measuring…"}
                </div>
              </div>
            </div>

            {relMultiple && (
              <div
                style={{
                  marginTop: 16,
                  background: T.greenBg2,
                  border: `1px solid ${T.greenBorder2}`,
                  borderRadius: 6,
                  padding: "14px 18px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: 8,
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 600, color: "#065F46" }}>
                  {relMultiple}× more citations after publishing the page
                </div>
                {before && after && (
                  <div style={{ fontSize: 12, color: T.green }}>
                    {after.cited} of {after.total} queries vs {before.cited} of{" "}
                    {before.total} before
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* the evidence */}
        <div
          style={{
            background: T.card,
            border: `1px solid ${T.border}`,
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "18px 28px",
              borderBottom: `1px solid ${T.divider}`,
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: "#fff",
                background: T.purple,
                padding: "3px 8px",
                borderRadius: 4,
              }}
            >
              {claim.badge}
            </span>
            <span style={{ fontSize: 15, fontWeight: 600, color: T.ink }}>
              The evidence
            </span>
            <span style={{ fontSize: 12, color: T.muted, marginLeft: 4 }}>
              Randomized matched-pair experiment · not just correlation
            </span>
          </div>
          <div style={{ padding: 28 }}>
            <div
              className="rdr-grid-3"
              style={{
                gap: 12,
                marginBottom: 24,
              }}
            >
              <EvidenceStat
                label={worked ? "How much it went up" : "Measured effect"}
                value={`${lr.estimate >= 0 ? "+" : ""}${estPct}%`}
                sub={
                  worked
                    ? "more citations vs pages we didn't change"
                    : "vs pages we didn't change"
                }
                accent={worked ? T.green : T.ink}
              />
              <EvidenceStat
                label="Range of likely outcomes"
                value={`${ciLowSigned}–${ciHighSigned}`}
                sub="the 90% confidence interval"
                accent={T.ink}
              />
              <EvidenceStat
                label="Chance this was luck"
                value={`${pPct}%`}
                sub={
                  lr.p_value < 0.05
                    ? "almost certainly a real effect"
                    : "not yet conclusive"
                }
                accent={T.ink}
              />
            </div>

            <div
              style={{
                background: T.subtle,
                border: `1px solid ${T.divider}`,
                borderRadius: 6,
                padding: "18px 20px",
              }}
            >
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: T.ink,
                  marginBottom: 8,
                }}
              >
                What this means in plain English
              </div>
              <div
                style={{ display: "flex", flexDirection: "column", gap: 8 }}
              >
                <PlainLine>
                  The page you published was cited in{" "}
                  <strong>{afterRate === null ? "—" : pct(afterRate)}</strong> of
                  buyer queries. Matched pages we didn't change stayed at{" "}
                  <strong>{beforeRate === null ? "—" : pct(beforeRate)}</strong>.{" "}
                  {worked
                    ? "Measured against those unchanged pages, that difference is the effect of your change."
                    : lr.verdict === "no_effect"
                      ? "Measured against those unchanged pages, the change didn't move your citation rate."
                      : "That difference isn't yet distinguishable from normal variation."}
                </PlainLine>
                <PlainLine>
                  {worked
                    ? `We're confident the real improvement is between ${ciLowSigned} and ${ciHighSigned}.`
                    : `The measured effect lands between ${ciLowSigned} and ${ciHighSigned}${
                        ciCrossesZero
                          ? ", and that range includes zero, so we can't yet claim a real effect."
                          : "."
                      }`}
                </PlainLine>
                <PlainLine>
                  {lr.p_value < 0.05
                    ? `There's only a ${pPct}% chance this happened by random chance.`
                    : `There's a ${pPct}% chance a result this size is just random variation, which is why we can't call it yet.`}
                </PlainLine>
              </div>
            </div>
          </div>
        </div>

        {/* how the experiment was run */}
        <div
          style={{
            background: T.card,
            border: `1px solid ${T.border}`,
            borderRadius: 8,
            padding: 28,
          }}
        >
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: T.label,
              letterSpacing: ".04em",
              textTransform: "uppercase",
              marginBottom: 10,
            }}
          >
            How the experiment was run
          </div>
          <div
            className="rdr-grid-2"
            style={{
              gap: 10,
            }}
          >
            <RunBox
              label="Treatment"
              value="The comparison page"
              sub="The page we built and published"
            />
            <RunBox
              label="Control"
              value="Similar pages, left unchanged"
              sub="Used as a fair baseline to compare against"
            />
            <RunBox
              label="Measurement window"
              value="Post-publish window"
              sub="Same buyer queries · same AI engines"
            />
            <RunBox
              label="Method"
              value="Before vs after comparison"
              sub="Compared to matched pages that didn't change, to isolate your fix"
            />
          </div>
        </div>

        {/* where AI is citing you now */}
        <div
          style={{
            background: T.card,
            border: `1px solid ${T.border}`,
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "18px 28px",
              borderBottom: `1px solid ${T.divider}`,
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: "#fff",
                background: T.dark,
                padding: "3px 8px",
                borderRadius: 4,
              }}
            >
              ↗
            </span>
            <span style={{ fontSize: 15, fontWeight: 600, color: T.ink }}>
              Where AI is citing you now
            </span>
          </div>
          <div style={{ padding: "24px 28px" }}>
            {citedPages.length === 0 ? (
              <div style={{ fontSize: 13, color: T.muted, lineHeight: 1.6 }}>
                No cited pages on your domain recorded in this window yet. As
                engines pick up your page, the pages they cite will appear here.
              </div>
            ) : (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                {citedPages.map(([url, count]) => (
                  <div
                    key={url}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 14,
                      padding: 14,
                      background: T.subtle,
                      border: `1px solid ${T.divider}`,
                      borderRadius: 6,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 13,
                        color: T.green2,
                        fontWeight: 700,
                        flexShrink: 0,
                      }}
                    >
                      ✓
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 600,
                          color: T.ink,
                          marginBottom: 2,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {url}
                      </div>
                      <div style={{ fontSize: 12, color: T.muted }}>
                        Cited in {count}
                        {postTotal ? ` of ${postTotal}` : ""} post-publish{" "}
                        {count === 1 ? "query" : "queries"}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* your next experiment */}
        <div
          style={{
            background: T.card,
            border: `1px solid ${T.border}`,
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "18px 28px",
              borderBottom: `1px solid ${T.divider}`,
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: "#fff",
                background: T.dark,
                padding: "3px 8px",
                borderRadius: 4,
              }}
            >
              →
            </span>
            <span style={{ fontSize: 15, fontWeight: 600, color: T.ink }}>
              Your next experiment
            </span>
          </div>
          <div style={{ padding: "24px 28px" }}>
            <div
              style={{
                fontSize: 13,
                color: T.muted,
                lineHeight: 1.6,
                marginBottom: 18,
              }}
            >
              Now that one fix has a measured result, it's time to test the next
              gap we found. Every experiment you run makes the next
              recommendation more accurate: the more you test, the sharper the
              insight.
            </div>
            <div
              style={{
                border: `1px solid ${T.border}`,
                borderRadius: 6,
                overflow: "hidden",
                marginBottom: 20,
              }}
            >
              <div
                style={{
                  padding: "16px 18px",
                  background: T.subtle,
                  borderBottom: `1px solid ${T.border}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                }}
              >
                <div
                  style={{ display: "flex", alignItems: "center", gap: 10 }}
                >
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 6,
                      background: T.greenBg,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: T.green,
                      }}
                    >
                      2
                    </span>
                  </div>
                  <div>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: T.ink,
                      }}
                    >
                      {nextLabel}
                    </div>
                    <div
                      style={{ fontSize: 12, color: T.muted, marginTop: 1 }}
                    >
                      {nextSignal
                        ? `Signal strength +${nextSignal.posterior_median.toFixed(
                            2,
                          )} · next biggest gap to test`
                        : "The next hypothesis to test"}
                    </div>
                  </div>
                </div>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: T.green,
                    background: T.greenBg,
                    padding: "3px 10px",
                    borderRadius: 20,
                    flexShrink: 0,
                  }}
                >
                  Signal
                </span>
              </div>
              <div style={{ padding: "14px 18px" }}>
                <div
                  style={{ fontSize: 13, color: T.ink2, lineHeight: 1.6 }}
                >
                  This is the next-strongest pattern we found in your category,
                  worth testing the same way: publish the change, then run a
                  matched experiment to measure whether your citation rate moves.
                </div>
              </div>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <button
                onClick={() => navigate({ screen: "wizard", workspaceId })}
                style={{ ...greenButton, fontWeight: 700 }}
              >
                Run the next experiment
              </button>
              <div style={{ fontSize: 13, color: T.muted }}>
                We'll generate the rewritten pages and set up the measurement.
              </div>
            </div>
          </div>
        </div>

        {/* moat note */}
        <div
          style={{
            background: "#F5F3FF",
            border: "1px solid #DDD6FE",
            borderRadius: 8,
            padding: "20px 24px",
            display: "flex",
            alignItems: "flex-start",
            gap: 14,
          }}
        >
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 6,
              background: T.purple,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <span style={{ fontSize: 16, color: "#fff" }}>↗</span>
          </div>
          <div>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "#5B21B6",
                marginBottom: 4,
              }}
            >
              Your results are compounding
            </div>
            <div style={{ fontSize: 13, color: "#6D28D9", lineHeight: 1.6 }}>
              Every experiment you run teaches Radar more about what actually
              works in your market, not generic advice. The more you run, the
              more precise the next recommendation gets.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function EvidenceStat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub: string;
  accent: string;
}) {
  return (
    <div
      style={{ border: `1px solid ${T.divider}`, borderRadius: 6, padding: 16 }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: ".08em",
          textTransform: "uppercase",
          color: T.label,
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 26,
          fontWeight: 800,
          color: accent,
          letterSpacing: "-.02em",
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 12, color: T.muted, marginTop: 4 }}>{sub}</div>
    </div>
  );
}

function RunBox({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div
      style={{
        background: T.subtle,
        border: `1px solid ${T.divider}`,
        borderRadius: 6,
        padding: "12px 14px",
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: T.label,
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 13, color: T.ink, fontWeight: 500 }}>{value}</div>
      <div style={{ fontSize: 12, color: T.muted, marginTop: 2 }}>{sub}</div>
    </div>
  );
}

function PlainLine({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 13,
        color: T.ink2,
        lineHeight: 1.6,
        paddingLeft: 14,
        borderLeft: `2px solid ${T.green2}`,
      }}
    >
      {children}
    </div>
  );
}
