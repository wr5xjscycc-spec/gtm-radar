# GTM Radar

**Measure whether you're cited in the AI answers your buyers trust, form the strongest hypothesis to fix it, run a randomized ship-vs-hold experiment, and report the actual citation lift with a confidence interval.** Everyone else hands you a visibility score; we run the experiment and prove what moved the needle.

> Built by a 4-person team. Open-source core. See `docs/` for the full design.

## Start here

| Doc | What it is |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The system: components, tools, data flow (read this first) |
| [`docs/PRD.md`](docs/PRD.md) | Product requirements — the honest "v2" product |
| [`docs/CONTRACT.md`](docs/CONTRACT.md) | The 9-record Convex data contract — **the cross-lane interface; agree this in Phase 0** |
| [`docs/phase-cards/INDEX.md`](docs/phase-cards/INDEX.md) | The 4-lane × 7-phase build plan + per-person briefs |
| [`ORCHESTRATION.md`](ORCHESTRATION.md) | How the 4 people/agents coordinate (lanes, branches, sync, contract) |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) + [`docs/TESTING.md`](docs/TESTING.md) | Conventions + the testing standard enforced in CI |
| [`prompts/INITIAL_PROMPT.md`](prompts/INITIAL_PROMPT.md) | The kickoff prompt each build agent receives |
| [`AGENTS.md`](AGENTS.md) | Repo map + rules for AI build agents |

## The 4 lanes (directories ↔ owners)

| Lane | Owner | Directory | Component |
|---|---|---|---|
| **P1** Platform & Experience | — | `platform/`, `convex/` | Convex backend, data model, live board, reporting + claim-ladder gating, scheduling/compliance |
| **P2** Measurement Engine | — | `measurement/` | 3 answer-engine adapters, K-repeats, adaptive sampling, labeling, cost guards |
| **P3** Sourcing & Enrichment | — | `sourcing/` | Battlefield (Fiber), content + off-page enrichment, query-gen, feature extraction |
| **P4** Intelligence & Loop | — | `analysis/` | Python stats (Bayesian hypotheses + randomized-DiD), asset gen + delivery, the moat dataset |

Lanes **never call each other directly** — they read/write the shared Convex records (`docs/CONTRACT.md`), joined on normalized domain. Lock the contract first; then build in parallel.

## Run the tests

```
npm install            # installs TS workspace deps (platform / measurement / sourcing)
npm test               # vitest across all TS lanes
pip install -r analysis/requirements.txt && pytest analysis   # P4 Python stats
```

CI (`.github/workflows/ci.yml`) runs both on every PR. **No card is done until its tests pass in CI.**

## License

MIT — see [`LICENSE`](LICENSE). The methodology core is open; the interventional dataset, vertical packs, and orchestration are the proprietary moat (see `docs/ARCHITECTURE.md` §16).
