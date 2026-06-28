# Contributing

## Workflow
1. Branch from `main`: `p<lane>/phase-<n>-<slug>` (e.g. `p3/phase-2-enrichment`).
2. Implement exactly your phase card's "Detailed tasks"; produce the records/artifacts it lists.
3. Write the tests required for that phase (see `docs/TESTING.md` and your brief's Testing standard).
4. Open a PR into `main`. In the description, link the phase card and list the records you read/write.
5. Get CODEOWNERS review (`.github/CODEOWNERS`). Merge only when **CI is green + DoD met + reviewed**.

## Definition of Done (every PR)
- [ ] The phase card's **Definition of Done** is satisfied.
- [ ] **Tests pass in CI** (`npm test` for TS lanes / `pytest` for `analysis/`).
- [ ] New behavior has tests in this PR (vendors mocked; integration via committed fixtures; stats via synthetic-data recovery).
- [ ] No changes to `docs/CONTRACT.md` or the Convex schema without the `ORCHESTRATION.md` §4 sign-off.
- [ ] Stayed within the lane's directory; keys are normalized domains.
- [ ] The non-negotiables (`ORCHESTRATION.md` §6) are respected — especially the claim-ladder (no causal output without a `lift_result`).

## Conventions
- TypeScript lanes use **vitest**; Python (`analysis/`) uses **pytest**.
- Keep external I/O behind adapters so it can be mocked.
- Version every derived artifact (`model_version` / `extractor_version` / `prior_version`).
- Commit messages: `p<lane>: <phase> — <what>`.

## Commit sign-off
End commit messages with:
```
Co-Authored-By: <your-agent-or-name>
```
