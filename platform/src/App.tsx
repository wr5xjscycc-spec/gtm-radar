import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { companyCardState, battlefieldProgress } from "./companyCard";

/**
 * Phase-0 live board (owner: P1) — minimal but real. Proves the DoD: write any
 * record via the convex/records mutations and watch it render here reactively
 * (Convex queries update with no polling). Phases 1+ build the onboarding card,
 * the gut-punch board, and claim-ladder gating on this spine.
 *
 * NOTE: requires `npx convex dev` (generates ../../convex/_generated and a
 * deployment URL). Not exercised in CI — UI glue is exempt per docs/TESTING.md.
 */
export function App() {
  const workspaces = useQuery(api.customers.listWorkspaces) ?? [];
  const [selected, setSelected] = useState<Id<"workspaces"> | null>(null);
  const create = useMutation(api.customers.createWorkspace);

  const wsId = selected ?? (workspaces[0]?._id as Id<"workspaces"> | undefined);

  return (
    <main style={{ fontFamily: "system-ui", maxWidth: 760, margin: "2rem auto" }}>
      <h1>GTM Radar — live board</h1>

      <OnboardingForm
        onCreate={(v) =>
          create({
            name: v.name,
            vertical: v.vertical,
            own_domain: v.own_domain,
            competitor_domains: v.competitors,
          })
        }
      />

      <h2>Workspaces</h2>
      <ul>
        {workspaces.map((w) => (
          <li key={w._id}>
            <button onClick={() => setSelected(w._id as Id<"workspaces">)}>
              {w.name} — {w.own_domain}
            </button>
          </li>
        ))}
      </ul>

      {wsId && <Board workspaceId={wsId} />}
    </main>
  );
}

function Board({ workspaceId }: { workspaceId: Id<"workspaces"> }) {
  const summary = useQuery(api.board.summary, { workspaceId });
  const battlefield = useQuery(api.board.battlefield, { workspaceId }) ?? [];
  const citations = useQuery(api.board.citationBoard, { workspaceId });

  const customer = battlefield.find((c) => c.role === "customer");
  const bf = battlefieldProgress(battlefield);

  return (
    <section>
      <h2>Board</h2>

      <CompanyCard understanding={customer?.understanding} />

      <h3>
        Battlefield — {bf.count} sourced{" "}
        {bf.filling ? <em>(filling… target {bf.target})</em> : "✓"}
      </h3>
      <ul>
        {battlefield.map((c) => (
          <li key={c._id}>
            {c.domain} — {c.role}
          </li>
        ))}
      </ul>

      <pre>{JSON.stringify(summary?.counts, null, 2)}</pre>

      <h3>Citation board (per engine)</h3>
      {citations &&
        Object.entries(citations.perEngine).map(([engine, e]) => (
          <p key={engine}>
            <strong>{engine}</strong>: cited {e.cited}/{e.total}
            {e.sources.length > 0 && ` — sources: ${e.sources.join(", ")}`}
          </p>
        ))}
      <small>{citations?.note}</small>
    </section>
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
    <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 16, margin: "12px 0" }}>
      <strong>Here's what you are</strong>
      {card.isReading ? (
        <p style={{ color: "#888" }}>reading your site…</p>
      ) : (
        <>
          <p style={{ fontSize: 18, margin: "8px 0" }}>{card.fields.what_you_are || "…"}</p>
          <dl style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 4, margin: 0 }}>
            <dt>Category</dt><dd>{card.fields.category || "…"}</dd>
            <dt>Positioning</dt><dd>{card.fields.positioning || "…"}</dd>
            <dt>ICP</dt><dd>{card.fields.icp || "…"}</dd>
          </dl>
          {card.status === "partial" && (
            <small style={{ color: "#888" }}>still reading: {card.missing.join(", ")}</small>
          )}
        </>
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
  }) => void;
}) {
  const [name, setName] = useState("");
  const [vertical, setVertical] = useState("");
  const [own, setOwn] = useState("");
  const [competitors, setCompetitors] = useState("");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onCreate({
          name,
          vertical,
          own_domain: own,
          competitors: competitors.split(",").map((s) => s.trim()).filter(Boolean),
        });
        setName("");
        setOwn("");
        setCompetitors("");
      }}
      style={{ display: "grid", gap: 8, maxWidth: 420 }}
    >
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Company name" required />
      <input value={vertical} onChange={(e) => setVertical(e.target.value)} placeholder="Vertical" required />
      <input value={own} onChange={(e) => setOwn(e.target.value)} placeholder="Your URL (e.g. acme.com)" required />
      <input value={competitors} onChange={(e) => setCompetitors(e.target.value)} placeholder="Competitor URLs (comma-separated)" />
      <button type="submit">Create workspace</button>
    </form>
  );
}
