# Orchestration — how 4 people (and their agents) build in parallel

This repo is built by **4 lanes working concurrently**, each person (and/or their AI build agent) owning one component. The whole scheme works because of one rule:

> **Lanes never call each other's code. They communicate only through the shared Convex records defined in [`docs/CONTRACT.md`](docs/CONTRACT.md), joined on normalized domain.**

Lock the contract in Phase 0 and everyone can build against it (and against fixtures) without blocking.

## 1. Lanes & directory ownership

| Lane | Owns these directories | Brief |
|---|---|---|
| **P1** Platform & Experience | `platform/`, `convex/` | `docs/phase-cards/P1-Platform-and-Experience.md` |
| **P2** Measurement Engine | `measurement/` | `docs/phase-cards/P2-Measurement-Engine.md` |
| **P3** Sourcing & Enrichment | `sourcing/` | `docs/phase-cards/P3-Sourcing-and-Enrichment.md` |
| **P4** Intelligence & Loop | `analysis/` | `docs/phase-cards/P4-Intelligence-and-Loop.md` |
| shared | `docs/`, `tests/integration/`, `.github/` | all (changes need sign-off — see §4) |

Ownership is enforced by [`.github/CODEOWNERS`](.github/CODEOWNERS): a PR touching a lane needs that lane's review.

## 2. Branching & PR model

- `main` is always green (CI passing). Nobody pushes to `main` directly.
- One branch per lane per phase: **`p<lane>/phase-<n>-<slug>`** — e.g. `p2/phase-3-measurement`, `p4/phase-4-bayesian`.
- Open a PR into `main` per phase card. The PR description links the phase card and lists which records it reads/writes.
- **Merge gate:** CI green (tests pass) **+** the phase card's Definition of Done met **+** CODEOWNERS review. (See `CONTRIBUTING.md`.)

## 3. Phase cadence (sync points)

Build is **7 phases (0–6)** with a shared milestone at each end (see `docs/phase-cards/INDEX.md`). Cadence:

1. **Phase 0 together** — agree `docs/CONTRACT.md`, stand up the repo + each lane's test harness (P1 creates the repo/CI; each lane wires its runner). End: thin slice runs E2E.
2. **Phases 1–6 in parallel** — each lane follows its brief, merging per-phase PRs.
3. **Re-sync at each 🎯 milestone** before starting the next phase — run `tests/integration`, confirm the milestone, then proceed.

Milestones: 0 thin-slice → 1 battlefield → 2 enriched+queries+features → 3 **measurement gut-punch** → 4 **day-1 product** → 5 **closed loop (lift w/ CI)** → 6 shipped.

## 4. The contract is sacred

`docs/CONTRACT.md` (and the Convex schema in `convex/`) is the cross-lane interface. **Any change to a record's shape requires sign-off from every lane that reads or writes it** (open a PR labeled `contract`, request all affected owners). Don't silently add/rename fields — a downstream lane's joins break invisibly (the classic failure: a domain that isn't normalized, so `company`↔`page`↔`measurement` silently don't join).

## 5. Working with your AI build agent

Each lane can be driven by an AI agent. To start an agent on a lane:

1. Give it [`prompts/INITIAL_PROMPT.md`](prompts/INITIAL_PROMPT.md) with the lane filled in. That prompt points it at `docs/ARCHITECTURE.md` (context), `docs/CONTRACT.md` (the interface), its phase-card brief, and the rules.
2. The agent works **only inside its lane's directory** (+ shared `docs/` reads). It must not edit other lanes' code or the contract without the §4 sign-off.
3. The agent opens a per-phase PR and ensures CI is green before requesting review.

**Anchor-bias rule (from the team's working agreement):** the agent that *writes* a component should not be the same agent/context that *debugs* its failures — dispatch a fresh agent for fixes. Keep reviewers independent of authors.

## 6. The non-negotiables (don't rebuild the broken product)

These design constraints come from a 3-round adversarial review (`docs/internal/redteam-and-patches.md`, kept out of the public repo). Every lane must respect them:

- **Measure the real, grounded engines** (OpenAI Responses API + `web_search`, etc.) — *never* plain chat-completions (no citations). Per-engine, never "one recipe."
- **Labels are rates, not coin flips** — P(cited) over K repeats with a CI.
- **A "loser" is case-control** (retrieved/considered but not cited), never an arbitrary uncited page.
- **Correlation ≠ causation** — the model is a *hypothesis generator*; causation is earned only by the randomized experiment. The claim-ladder is enforced in the UI.
- **Effective N = number of companies (~20–40), not row count** — pseudo-replication; cluster by company; shrink hard.
- **Off-page/earned/entity signals dominate citation** — supply and model them, not just on-page features.
- **Cost is a constraint** — adaptive sampling, category caching, monthly cadence; no weekly multi-engine sweeps.

## 7. Status & communication

- Use GitHub PRs + Issues for cross-lane coordination; label blocking items `needs-contract` / `blocked`.
- Keep `main`'s `docs/phase-cards/INDEX.md` matrix as the source of truth for who's on which phase.
