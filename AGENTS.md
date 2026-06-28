# AGENTS.md — rules for AI build agents

If you are an AI agent working in this repo, read this first, then `prompts/INITIAL_PROMPT.md`.

## Orientation (read in this order)
1. `docs/ARCHITECTURE.md` — the system and the full tool inventory (your context).
2. `docs/CONTRACT.md` — the 9-record interface between lanes (you read/write these; never call another lane's code).
3. Your lane brief in `docs/phase-cards/P{1,2,3,4}-*.md` — tasks, tests, DoD per phase.
4. `ORCHESTRATION.md` — branches, PR/merge gate, contract-change rule, non-negotiables.
5. `CONTRIBUTING.md` + `docs/TESTING.md` — testing rules CI enforces.

## Repo map
- `platform/` → P1 (Convex/React, TS). `convex/` → P1 Convex schema + functions.
- `measurement/` → P2 (answer-engine adapters, TS).
- `sourcing/` → P3 (Fiber/Orange Slice/SERP/Reddit enrichment + features, TS).
- `analysis/` → P4 (Python stats service: Bayesian + DiD, delivery).
- `tests/integration/` → cross-lane tests + `fixtures/`.
- `docs/` → all design docs (read-only for most work). `docs/internal/` is gitignored (strategy).

## Hard rules
- **Stay in your lane's directory.** Don't edit another lane's code.
- **Don't change `docs/CONTRACT.md` or the Convex schema** without the sign-off in `ORCHESTRATION.md` §4.
- **Always key on normalized domain/URL** via P1's helper — never invent a key format.
- **Write tests in the same PR** (mocks for vendors, fixtures for integration, synthetic data for stats). No live API calls in CI.
- **Respect the non-negotiables** (`ORCHESTRATION.md` §6): grounded engines only, rates not coin-flips, case-control losers, correlation≠causation (claim-ladder), effective-N=companies, off-page matters, cost is a constraint.
- **Don't mark a card done until CI is green** and the card's Definition of Done is met.

## Commands
- TS tests: `npm install` then `npm test`.
- Python tests: `pip install -r analysis/requirements.txt` then `pytest analysis`.
