# Testing standard

**No phase card is Done until its work ships with passing automated tests in CI.** CI (`.github/workflows/ci.yml`) runs on every push and PR; `main` stays green.

## Runners

| Lane(s) | Runner | Run locally |
|---|---|---|
| P1 `platform/`, P2 `measurement/`, P3 `sourcing/` (TypeScript) | **vitest** | `npm test` (all TS workspaces) |
| P4 `analysis/` (Python) | **pytest** | `pip install -r analysis/requirements.txt && pytest analysis` |
| cross-lane | vitest + recorded fixtures | `tests/integration/` |

## The five rules

1. **External APIs are mocked in unit tests.** OpenAI, Perplexity, Gemini, Fiber, Orange Slice, SERP, Reddit, CMS — never hit the network in a unit test. Use mocks/stubs returning known shapes.
2. **Integration tests use recorded fixtures, not live calls.** Record a real response once, commit it under `tests/integration/fixtures/`, replay it. CI must be deterministic and free — **no live API calls in CI** (cost + flakiness + non-determinism).
3. **Statistical code is tested on synthetic data with known ground truth.** Plant an effect (or a null), then assert the model recovers it (sign, rough magnitude within CI) and flags nulls as noise. This is how we test *honesty*, not just "it runs."
4. **Tests land in the same PR as the code.** A PR with new behavior and no tests does not pass review.
5. **Coverage target ≥ 70% on each lane's core logic** by Phase 6 (adapters, parsers, aggregation, model, gating). UI glue and thin I/O wrappers are exempt.

## Per-phase minimums (summary — see each lane's brief for specifics)

| Phase | Everyone |
|---|---|
| 0 | Test harness wired; one example test green in CI; lane scaffold committed |
| 1–2 | Unit tests for new units (vendors mocked); fixtures committed |
| 3 | Lane core logic tested + one recorded-fixture integration test |
| 4 | Day-1 logic tested — incl. **claim-ladder gating** (P1) and **Bayesian recovery on synthetic data** (P4) |
| 5 | The loop tested — incl. **DiD recovery on a simulated panel with a known lift** (P4) and compliance/scheduler logic (P1) |
| 6 | Coverage ≥ target; integration/e2e happy path; honesty-audit assertions (no causal output without a `lift_result`) |

## Honesty tests (special, mandatory)

Because the product's whole credibility is "we don't overclaim," two assertions are **required** and must never regress:

- **Claim-ladder guard (P1):** a test proving the UI cannot render a causal statement unless a `lift_result` record exists for that experiment.
- **No-causation-without-experiment (P4):** a test proving the analysis service emits causal output (`lift_result`) only from the randomized DiD path, never from `model_fit` coefficients.
