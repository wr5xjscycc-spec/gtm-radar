import { useState, Component, type ReactNode } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { companyCardState, battlefieldProgress } from "./companyCard";
import {
  llmExpandRatio,
  seedSourceBreakdown,
  coverageSummary,
  featureVectorView,
} from "./enrichmentReview";
import { headline, measurementProgress } from "./gutPunch";
import { rankedGaps, licensedRung, RUNG_BADGE, makeClaim, RUNG } from "./claimLadder";
import { opsSummary } from "./observability";

/**
 * GTM Radar — the live citation-measurement console (owner: P1).
 *
 * Every panel is a reactive view over Convex; rows fill in with no polling. The
 * "Signal" design system (src/styles/theme.css) is presentation only — the data
 * wiring, the claim-ladder gate (causal language is impossible without a
 * lift_result), and the Hawthorne rule (control pages are never rendered) are
 * load-bearing and unchanged.
 *
 * NOTE: requires `npx convex dev` (generates ../../convex/_generated and a
 * deployment URL). Not exercised in CI — UI glue is exempt per docs/TESTING.md.
 */

function RadarMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" stroke="var(--signal)" strokeOpacity="0.4" />
      <circle cx="12" cy="12" r="4.5" stroke="var(--signal)" strokeOpacity="0.6" />
      <path d="M12 12 L12 2.5" stroke="var(--signal)" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="12" cy="12" r="1.5" fill="var(--signal)" />
    </svg>
  );
}

/** Catches render/query failures so a panel error never blanks the whole board. */
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="locked" role="alert">
          <LockIcon />
          Couldn't load this view. Check the connection and reload.
        </div>
      );
    }
    return this.props.children;
  }
}

export function App() {
  const wsResult = useQuery(api.customers.listWorkspaces);
  const workspaces = wsResult ?? [];
  const loading = wsResult === undefined;
  const [selected, setSelected] = useState<Id<"workspaces"> | null>(null);
  const create = useMutation(api.customers.createWorkspace);

  const wsId = selected ?? (workspaces[0]?._id as Id<"workspaces"> | undefined);

  const onCreate = (v: {
    name: string;
    vertical: string;
    own_domain: string;
    competitors: string[];
  }) =>
    create({
      name: v.name,
      vertical: v.vertical,
      own_domain: v.own_domain,
      competitor_domains: v.competitors,
    });

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          <span className="brand__mark">
            <RadarMark size={16} />
          </span>
          GTM Radar
          <span className="brand__sub">citation console</span>
        </span>
        <span className="topbar__spacer" />
        <span className="live" title="Convex reactive; updates with no polling">
          <span className="live__dot" />
          live
        </span>
      </header>

      <main className="shell">
        {loading ? (
          <BoardSkeleton />
        ) : workspaces.length === 0 ? (
          <section className="empty" aria-labelledby="empty-title">
            <span className="empty__mark">
              <RadarMark size={26} />
            </span>
            <h2 id="empty-title">See who the AI engines actually cite</h2>
            <p>
              Add your company and a few competitors. GTM Radar measures which answer engines cite
              you for your buyers' real questions, then helps you prove what moves the needle.
            </p>
            <div className="panel" style={{ width: "100%", textAlign: "left" }}>
              <div className="section-label">New workspace</div>
              <OnboardingForm onCreate={onCreate} />
            </div>
          </section>
        ) : (
          <>
            <div className="reveal" style={{ marginBottom: 28 }}>
              <div className="section-label">Workspaces</div>
              <div className="ws-switch">
                {workspaces.map((w) => (
                  <button
                    key={w._id}
                    className="ws-chip"
                    aria-pressed={w._id === wsId}
                    onClick={() => setSelected(w._id as Id<"workspaces">)}
                  >
                    {w.name}
                    <span className="ws-chip__dom">{w.own_domain}</span>
                  </button>
                ))}
              </div>
            </div>

            {wsId && (
              <ErrorBoundary>
                <Board workspaceId={wsId} />
              </ErrorBoundary>
            )}

            <details className="panel" style={{ marginTop: 40 }}>
              <summary
                style={{
                  cursor: "pointer",
                  color: "var(--ink-2)",
                  fontFamily: "var(--mono)",
                  fontSize: 13,
                }}
              >
                + Add another workspace
              </summary>
              <div style={{ marginTop: 16 }}>
                <OnboardingForm onCreate={onCreate} />
              </div>
            </details>
          </>
        )}
      </main>
    </div>
  );
}

function Board({ workspaceId }: { workspaceId: Id<"workspaces"> }) {
  const summary = useQuery(api.board.summary, { workspaceId });
  const battlefield = useQuery(api.board.battlefield, { workspaceId }) ?? [];
  const pages = useQuery(api.board.pages, { workspaceId }) ?? [];
  const queries = useQuery(api.board.queries, { workspaceId }) ?? [];
  const gut = useQuery(api.board.gutPunch, { workspaceId });
  const measurements = useQuery(api.board.measurements, { workspaceId }) ?? [];
  const diagnosis = useQuery(api.board.diagnosis, { workspaceId });

  const customer = battlefield.find((c) => c.role === "customer");
  const bf = battlefieldProgress(battlefield);
  const counts = (summary?.counts ?? {}) as Record<string, number>;

  return (
    <div className="board-stack">
      <section className="reveal reveal--1">
        <CompanyCard understanding={customer?.understanding} />
      </section>

      <section className="reveal reveal--2 panel">
        <div className="bf__head">
          <h2 className="panel__title">Battlefield</h2>
          <span className="num bf__count">{bf.count} sourced</span>
          <span aria-live="polite">
            {bf.filling ? (
              <span className="faint" style={{ fontSize: 13 }}>
                filling… target {bf.target}
              </span>
            ) : (
              <span className="pos" style={{ fontSize: 13 }}>
                complete
              </span>
            )}
          </span>
        </div>
        <div className="bf-grid">
          {battlefield.map((c) => {
            const you = c.role === "customer";
            return (
              <div key={c._id} className={`bf-row${you ? " is-you" : ""}`}>
                <span>{c.domain}</span>
                <span className={`role-tag${you ? " is-you" : ""}`}>{c.role}</span>
              </div>
            );
          })}
        </div>
        {Object.keys(counts).length > 0 && (
          <div className="seed-breakdown" style={{ marginTop: 16 }}>
            {Object.entries(counts).map(([k, n]) => (
              <span key={k} className="seed-chip">
                {k} <b className="num">{n}</b>
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="reveal reveal--3 panel">
        <GutPunchBoard gut={gut} measurements={measurements} />
      </section>

      <div className="grid-2">
        <section className="panel">
          <DiagnosisPanel diagnosis={diagnosis} />
        </section>
        <section className="panel">
          <ExperimentConsole workspaceId={workspaceId} />
        </section>
      </div>

      <section className="panel">
        <EnrichmentReview pages={pages} queries={queries} companies={battlefield} />
      </section>

      <section>
        <OpsView workspaceId={workspaceId} />
      </section>
    </div>
  );
}

// P1·6: observability — per-cycle spend is VISIBLE (unit economics + judges).
function OpsView({ workspaceId }: { workspaceId: Id<"workspaces"> }) {
  const runs = useQuery(api.board.runRecords, { workspaceId }) ?? [];
  if (runs.length === 0) return null;
  const s = opsSummary(runs as any);
  return (
    <>
      <div className="section-label">Spend &amp; reliability</div>
      <div className="ops">
        <div className="stat">
          <span className={`stat__num ${s.within_budget ? "is-pos" : "is-neg"}`}>
            ${s.total_spend}
          </span>
          <span className="stat__label">total spend</span>
          <span className="stat__sub">
            {s.within_budget ? "within budget" : `${s.over_budget_cycles} cycle(s) over`}
          </span>
        </div>
        <div className="stat">
          <span className="stat__num">${s.avg_spend_per_cycle}</span>
          <span className="stat__label">avg / cycle</span>
          <span className="stat__sub">
            {s.cycles} cycle{s.cycles === 1 ? "" : "s"}
          </span>
        </div>
        <div className="stat">
          <span className="stat__num">{s.total_calls}</span>
          <span className="stat__label">engine calls</span>
          <span className="stat__sub">{s.total_queries} queries</span>
        </div>
        <div className="stat">
          <span className="stat__num">
            {Object.values(s.per_engine_error_rate).length > 0
              ? `${(
                  Math.max(...(Object.values(s.per_engine_error_rate) as number[])) * 100
                ).toFixed(1)}%`
              : "0%"}
          </span>
          <span className="stat__label">peak error rate</span>
          <span className="stat__sub">
            {Object.entries(s.per_engine_error_rate)
              .map(([e, r]) => `${e} ${((r as number) * 100).toFixed(0)}%`)
              .join(" · ") || "no errors"}
          </span>
        </div>
      </div>
    </>
  );
}

// P1·5: experiment console + compliance. Controls are NEVER shown (Hawthorne);
// the loop is gated (publish before running); Rung-2 causal renders only when a
// lift_result exists.
function ExperimentConsole({ workspaceId }: { workspaceId: Id<"workspaces"> }) {
  const feed = useQuery(api.experiments.consoleFeed, { workspaceId }) ?? [];
  const requestPublish = useMutation(api.experiments.requestPublish);
  const recordPublish = useMutation(api.experiments.recordPublish);
  if (feed.length === 0) {
    return (
      <>
        <h2 className="panel__title">Experiments</h2>
        <p className="panel__note">
          No experiments yet. Once a hypothesis survives, design a randomized test to earn a causal
          result.
        </p>
      </>
    );
  }
  return (
    <>
      <h2 className="panel__title">Experiments</h2>
      <div>
        {feed.map((e: any) => (
          <div key={e._id} className="exp-row">
            <div className="exp-row__head">
              <span className="num exp-row__pairs">
                {e.n_pairs} pair{e.n_pairs === 1 ? "" : "s"}
              </span>
              <span className={`status-pill status-pill--${e.status}`}>
                {e.status.replace(/_/g, " ")}
              </span>
            </div>
            {/* control_page intentionally absent — Hawthorne */}
            <div className="exp-row__meta">treatment: {e.treatments.join(", ")}</div>

            <div className="exp-actions">
              {e.status === "designing" && (
                <button
                  className="btn btn--sm"
                  onClick={() => requestPublish({ experimentId: e._id })}
                >
                  Mark ready to publish
                </button>
              )}
              {e.status === "awaiting_publish" && (
                <>
                  <button
                    className="btn btn--primary btn--sm"
                    onClick={() => recordPublish({ experimentId: e._id })}
                  >
                    Mark as published
                  </button>
                  <span className="expire-note">slot expires in 14 days</span>
                </>
              )}
            </div>

            {e.lift ? (
              <div className="causal">
                <span className="causal__badge">
                  <RadarMark size={13} /> Causal · experiment
                </span>
                <p>
                  Treated pages saw{" "}
                  <span className="num pos">{(e.lift.estimate * 100).toFixed(0)}%</span> vs matched
                  controls{" "}
                  <span className="faint num">
                    (CI {(e.lift.ci_low * 100).toFixed(0)}–{(e.lift.ci_high * 100).toFixed(0)}%, p=
                    {e.lift.p_value})
                  </span>{" · "}
                  {e.lift.verdict}
                </p>
              </div>
            ) : (
              <div className="locked" style={{ marginTop: 12 }}>
                <LockIcon />
                No causal result yet. Rung-2 locked until the experiment completes.
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function LockIcon() {
  return (
    <svg
      className="locked__icon"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

// P1·4: diagnosis + claim-ladder gating. Renders model_fit as RANKED HYPOTHESES
// (surviving signals separated from noise, each with its CI + noise flag), at the
// rung the evidence licenses. Causal language is structurally impossible here —
// the causal block only renders when a lift_result exists (rung 2).
function DiagnosisPanel({ diagnosis }: { diagnosis: any }) {
  if (!diagnosis) {
    return (
      <>
        <h2 className="panel__title">Diagnosis</h2>
        <p className="pending" style={{ marginTop: 8 }}>
          <span className="pending__dot" />
          fitting the model…
        </p>
      </>
    );
  }
  const evidence = {
    hasModelFit: diagnosis.modelFits.length > 0,
    hasLiftResult: diagnosis.hasLiftResult,
  };
  if (!evidence.hasModelFit) {
    return (
      <>
        <h2 className="panel__title">Diagnosis</h2>
        <p className="pending" style={{ marginTop: 8 }}>
          <span className="pending__dot" />
          fitting the model…
        </p>
      </>
    );
  }

  const fit = diagnosis.modelFits[0];
  const { surviving, noise } = rankedGaps(fit.coefficients);
  const rung = licensedRung(evidence);
  const rungClass = evidence.hasLiftResult
    ? "rung rung--causal"
    : "rung rung--hypothesis";

  // Relative CI track shared across surviving signals (presentation only).
  const lows = surviving.map((c: any) => c.ci_low);
  const highs = surviving.map((c: any) => c.ci_high);
  const lo = Math.min(0, ...lows);
  const hi = Math.max(0, ...highs);
  const span = hi - lo || 1;

  return (
    <>
      <h2 className="panel__title">
        Diagnosis <span className={rungClass}>{RUNG_BADGE[rung]}</span>
      </h2>
      <p className="panel__note">
        Hypotheses from <span className="num">{fit.n_companies}</span> companies (effective N).
        Correlational, not causal. Test before you trust.
      </p>

      <div style={{ marginTop: 18 }}>
        <div className="section-label">Surviving signals ({surviving.length})</div>
        {surviving.map((c: any) => {
          const left = ((c.ci_low - lo) / span) * 100;
          const width = Math.max(2, ((c.ci_high - c.ci_low) / span) * 100);
          return (
            <div key={c.feature} className="signal-row">
              <span className="signal-row__name">{c.feature}</span>
              <span className="signal-row__stat">
                {c.posterior_median.toFixed(2)}{" "}
                <span className="signal-row__ci">
                  (90% {c.ci_low.toFixed(2)}–{c.ci_high.toFixed(2)})
                </span>
              </span>
              <div className="ci-bar" aria-hidden="true">
                <span className="ci-bar__span" style={{ left: `${left}%`, width: `${width}%` }} />
              </div>
              <span className="signal-row__desc">
                correlates with citation in this category; test it
              </span>
            </div>
          );
        })}
      </div>

      {noise.length > 0 && (
        <div className="noise-note">
          <h4>Not distinguishable from noise ({noise.length})</h4>
          <small>{noise.map((c: any) => c.feature).join(" · ")}</small>
        </div>
      )}

      {/* Causal block — IMPOSSIBLE to render without a lift_result (claim-ladder). */}
      {evidence.hasLiftResult ? (
        <CausalBlock liftResults={diagnosis.liftResults} />
      ) : (
        <div className="locked">
          <LockIcon />
          No causal claims yet. Run a randomized experiment to earn a Rung-2 result.
        </div>
      )}
    </>
  );
}

function CausalBlock({ liftResults }: { liftResults: any[] }) {
  // Reaching here means a lift_result exists; makeClaim(CAUSAL) is now licensed.
  const claim = makeClaim(RUNG.CAUSAL, { hasLiftResult: true });
  return (
    <div className="causal">
      <span className="causal__badge">
        <RadarMark size={13} /> {claim.badge}
      </span>
      {liftResults.map((lr: any) => (
        <p key={lr._id}>
          Treated pages saw{" "}
          <span className="num pos">{(lr.estimate * 100).toFixed(0)}%</span> vs matched controls{" "}
          <span className="faint num">
            (CI {(lr.ci_low * 100).toFixed(0)}–{(lr.ci_high * 100).toFixed(0)}%, p={lr.p_value})
          </span>{" · "}
          {lr.verdict}
        </p>
      ))}
    </div>
  );
}

// P1·3: the gut-punch — "you 0/12 · competitor 9/12 · cited from these sources",
// per engine, live. The demo's emotional core. Shows a measurement (not a model).
function GutPunchBoard({ gut, measurements }: { gut: any; measurements: any[] }) {
  const prog = measurementProgress(measurements);
  if (!gut) {
    return (
      <>
        <div className="gut__head">
          <h2 className="gut__q">Are you cited?</h2>
          <span className="pending">
            <span className="pending__dot" />
            measuring…
          </span>
        </div>
        <div className="engines">
          {[0, 1].map((i) => (
            <div key={i} className="engine">
              <div className="skeleton skel-line w-40" />
              <div className="skeleton skel-line w-80" style={{ height: 24 }} />
              <div className="skeleton skel-line w-60" />
            </div>
          ))}
        </div>
      </>
    );
  }
  return (
    <>
      <div className="gut__head">
        <h2 className="gut__q">Are you cited?</h2>
        <span className="gut__progress" aria-live="polite">
          {prog.done} measurements · {prog.pct}% {prog.pct < 100 ? "sweeping…" : "complete"}
        </span>
      </div>
      <div className="engines">
        {Object.entries(gut.perEngine).map(([engine, e]: [string, any]) => (
          <div key={engine} className="engine">
            <div className="engine__name">
              <RadarMark size={12} />
              {engine} <b>web_search</b>
            </div>
            <div className="engine__line">{headline(e.you, e.topCompetitor)}</div>
            {e.citedSources.length > 0 && (
              <div className="engine__sources">
                cited from <b>{e.citedSources.join(", ")}</b>
              </div>
            )}
          </div>
        ))}
      </div>
      {gut.note && (
        <p className="panel__note" style={{ marginTop: 14 }}>
          {gut.note}
        </p>
      )}
    </>
  );
}

// Humanize the internal seed-source keys for display.
const SEED_LABEL: Record<string, string> = {
  paa: "People Also Ask",
  keyword: "Keyword data",
  reddit: "Reddit",
  analytics: "Your analytics",
  llm_expand: "LLM-expanded",
};

// P1·2: makes P3's supply auditable. SURFACES (never hides) low off-page
// coverage + an llm_expand-heavy query set — the two red-team holes.
function EnrichmentReview({
  pages,
  queries,
  companies,
}: {
  pages: any[];
  queries: any[];
  companies: any[];
}) {
  const grounding = llmExpandRatio(queries);
  const breakdown = seedSourceBreakdown(queries);
  const groundingPct = Math.round(grounding.ratio * 100);
  return (
    <>
      <h2 className="panel__title">Enrichment review</h2>
      <p className="panel__note">The supply behind the numbers: surfaced, not hidden.</p>

      <div style={{ marginTop: 18 }}>
        <div className="section-label">Query grounding ({grounding.total})</div>
        <div className="metric-line">
          <span className={`metric-line__val ${grounding.tooHigh ? "neg" : "pos"}`}>
            {groundingPct}% LLM-expanded
          </span>
          <span className={`bar ${grounding.tooHigh ? "is-running" : ""}`} aria-hidden="true">
            <span
              className={`bar__fill ${grounding.tooHigh ? "is-neg" : ""}`}
              style={{ width: `${groundingPct}%` }}
            />
          </span>
          <span className="faint" style={{ fontSize: 12.5 }}>
            {grounding.tooHigh ? "ungrounded, needs more real seeds" : "grounded"}
          </span>
        </div>
        <div className="seed-breakdown">
          {Object.entries(breakdown)
            .filter(([, n]) => (n as number) > 0)
            .map(([k, n]) => (
              <span key={k} className="seed-chip">
                {SEED_LABEL[k] ?? k} <b className="num">{n as number}</b>
              </span>
            ))}
        </div>
      </div>

      <div style={{ marginTop: 22 }}>
        <div className="section-label">Off-page coverage</div>
        {companies.map((c) => {
          const cov = coverageSummary(c);
          const pct = Math.round(cov.coverage * 100);
          return (
            <div key={c._id} className="cov-row">
              <span className="cov-row__dom">{c.domain}</span>
              <span className="bar" aria-hidden="true">
                <span
                  className={`bar__fill ${pct < 50 ? "is-neg" : pct < 80 ? "is-warn" : ""}`}
                  style={{ width: `${pct}%` }}
                />
              </span>
              <span className="cov-row__pct">{pct}%</span>
              {cov.missing.length > 0 && (
                <span className="miss">missing {cov.missing.join(", ")}</span>
              )}
              {cov.flags.map((f) => (
                <span key={f} className="flag">
                  {f}
                </span>
              ))}
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 22 }}>
        <div className="section-label">Feature vectors ({pages.length} pages)</div>
        {pages.map((p) => {
          const v = featureVectorView(p);
          return (
            <details key={p._id} className="feat">
              <summary>
                {p.url}
                <span className="faint" style={{ marginLeft: "auto" }}>
                  {v.extractor_version}
                </span>
              </summary>
              <div className="feat__body">
                {v.fields.map((f) => (
                  <span key={f.key} className={`feat__field ${f.present ? "" : "is-absent"}`}>
                    <span>{f.key}</span>
                    <span>{f.present ? String(f.value) : "—"}</span>
                  </span>
                ))}
              </div>
            </details>
          );
        })}
      </div>
    </>
  );
}

// PRD Stage 1–2: the "here's what you are" trust card. Renders progressively
// (reading -> partial -> ready) as P3's understanding fields land via reactivity.
function CompanyCard({
  understanding,
}: {
  understanding?: {
    category?: string;
    icp?: string;
    positioning?: string;
    what_you_are?: string;
  };
}) {
  const card = companyCardState(understanding);
  return (
    <div className="panel you">
      <div>
        <div className="you__label">Here's what you are</div>
        {card.isReading ? (
          <div>
            <div className="skeleton skel-line w-80" style={{ height: 22 }} />
            <div className="skeleton skel-line w-60" />
            <p className="pending" style={{ marginTop: 12 }}>
              <span className="pending__dot" />
              reading your site…
            </p>
          </div>
        ) : (
          <>
            <p className="you__headline">{card.fields.what_you_are || "…"}</p>
            {card.status === "partial" && (
              <p className="faint" style={{ fontSize: 12.5, marginTop: 10, fontFamily: "var(--mono)" }}>
                still reading: {card.missing.join(", ")}
              </p>
            )}
          </>
        )}
      </div>
      {!card.isReading && (
        <dl className="kv">
          <dt>Category</dt>
          <dd>{card.fields.category || "…"}</dd>
          <dt>Positioning</dt>
          <dd>{card.fields.positioning || "…"}</dd>
          <dt>ICP</dt>
          <dd>{card.fields.icp || "…"}</dd>
        </dl>
      )}
    </div>
  );
}

function OnboardingForm({
  onCreate,
}: {
  onCreate: (v: {
    name: string;
    vertical: string;
    own_domain: string;
    competitors: string[];
  }) => void | Promise<unknown>;
}) {
  const [name, setName] = useState("");
  const [vertical, setVertical] = useState("");
  const [own, setOwn] = useState("");
  const [competitors, setCompetitors] = useState("");
  const [touched, setTouched] = useState(false);
  const [submitError, setSubmitError] = useState("");

  const domainOk = /^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(own.trim());
  const ownInvalid = touched && own.trim().length > 0 && !domainOk;

  return (
    <form
      className="onboard"
      onSubmit={async (e) => {
        e.preventDefault();
        setTouched(true);
        setSubmitError("");
        if (!name.trim() || !vertical.trim() || !domainOk) return;
        try {
          // Clear only after the mutation resolves, so typed input survives a failure.
          await onCreate({
            name: name.trim(),
            vertical: vertical.trim(),
            own_domain: own.trim(),
            competitors: competitors
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          });
          setName("");
          setOwn("");
          setCompetitors("");
          setTouched(false);
        } catch {
          setSubmitError("Couldn't create the workspace. Check the connection and try again.");
        }
      }}
    >
      <div className="field">
        <label className="field__label" htmlFor="ob-name">
          Company name
        </label>
        <input
          id="ob-name"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Northbeam"
          required
        />
      </div>
      <div className="field">
        <label className="field__label" htmlFor="ob-vertical">
          Vertical
        </label>
        <input
          id="ob-vertical"
          className="input"
          value={vertical}
          onChange={(e) => setVertical(e.target.value)}
          placeholder="marketing attribution"
          required
        />
      </div>
      <div className="field">
        <label className="field__label" htmlFor="ob-domain">
          Your domain
        </label>
        <input
          id="ob-domain"
          className="input"
          value={own}
          onChange={(e) => setOwn(e.target.value)}
          onBlur={() => setTouched(true)}
          placeholder="northbeam.io"
          aria-invalid={ownInvalid}
          required
        />
        {ownInvalid && (
          <span className="field__error" role="alert">
            Enter a domain like northbeam.io (no http://).
          </span>
        )}
      </div>
      <div className="field">
        <label className="field__label" htmlFor="ob-competitors">
          Competitor domains (optional)
        </label>
        <input
          id="ob-competitors"
          className="input"
          value={competitors}
          onChange={(e) => setCompetitors(e.target.value)}
          placeholder="triplewhale.com, rockerbox.com"
          aria-required="false"
        />
      </div>
      <button type="submit" className="btn btn--primary">
        Create workspace
      </button>
      {submitError && (
        <span className="field__error" role="alert">
          {submitError}
        </span>
      )}
    </form>
  );
}

function BoardSkeleton() {
  return (
    <div className="board-stack" aria-busy="true" aria-live="polite">
      <div className="panel">
        <div className="skeleton skel-line w-40" />
        <div className="skeleton skel-line w-80" style={{ height: 22 }} />
        <div className="skeleton skel-line w-60" />
      </div>
      <div className="panel">
        <div className="skeleton skel-line w-40" />
        <div className="engines" style={{ marginTop: 16 }}>
          <div className="skeleton skel-block" />
          <div className="skeleton skel-block" />
        </div>
      </div>
    </div>
  );
}
