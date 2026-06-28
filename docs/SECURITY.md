# Security & ToS posture (v1)

P1 sign-off for the Phase-6 security pass. Adversarial check: try to find a way
the product leaks a key, crosses workspaces, or scrapes a UI — and confirm it can't.

## Secrets
- **All vendor keys live in Convex deployment env** (`npx convex env set …`) and/or
  a **gitignored `.env`** — never in the client bundle, never in a query/mutation,
  never committed. (`.env`, `.env.local` are in `.gitignore`; CI runs with NO live
  keys — every vendor is mocked.)
- The React board only ever receives `VITE_CONVEX_URL` (a public deployment URL,
  safe to expose). External API calls happen exclusively in Convex **actions**,
  server-side, reading `process.env`.
- Verified: a repo-wide secret scan (`sk-…`, `sk_live_…`, `AIza…`, `pplx-…`) runs
  before every commit; no real key has ever been staged.

## Workspace isolation
- Every record carries a `workspaceId`; every query/mutation is scoped via
  `convex/lib/auth.requireWorkspace`. With Convex Auth enabled (`REQUIRE_AUTH`),
  a caller cannot read another owner's workspace.
- Pre-auth bring-up is single-tenant dev only; flip `REQUIRE_AUTH` for prod.

## ToS posture (API-only)
- **v1 measures via official APIs only** (OpenAI Responses API + `web_search`).
  No scraping of answer-engine UIs.
- **AI Overviews (Google) is explicitly deferred** — there is no API, and a
  Browserbase/Playwright capture path carries ToS risk. Out of v1 by design.
- Off-page evidence is gathered via the grounded search API, not UI scraping.

## Reproducibility / honesty (cross-refs)
- Every derived record carries a `*_version` (`model_version` / `extractor_version`
  / `prior_version`) so a mid-run change is detectable.
- The claim-ladder (`platform/src/claimLadder.ts` + `convex/board.diagnosis`) makes
  causal language impossible without a `lift_result`. The analysis-lane honesty
  audit (`analysis/tests/test_honesty_audit.py`) asserts the same on the model side.

## Observability
- Per-cycle `run_records` (queries, calls, **$ spend**, per-engine error rates)
  are surfaced in the ops view — spend is never invisible (unit economics +
  judge transparency).
