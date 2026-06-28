# convex/ — Convex backend (owned by P1)

The reactive backend and the **cross-lane contract in code**: the 9-record
schema, the domain/URL normalization that keys every join, the sanctioned write
path, the reactive board queries, and the action pattern every lane copies.

> The schema here is the code form of [`../docs/CONTRACT.md`](../docs/CONTRACT.md).
> Changing it requires all-affected-owner sign-off (see `../ORCHESTRATION.md` §4).

## Files
| File | What |
|---|---|
| `schema.ts` | The 9 records as Convex tables — workspace-scoped, versioned, join-indexed. |
| `lib/domain.ts` | **The single domain/URL normalization primitive.** Every key goes through it. |
| `lib/auth.ts` | Workspace-scoping helpers (`getOwner`, `requireWorkspace`). |
| `customers.ts` | Onboarding mutation (`createWorkspace`) + workspace queries. |
| `records.ts` | The cross-lane **write path** — one normalized-write mutation per record. |
| `board.ts` | Reactive **read** queries powering the live board. |
| `auth.config.ts` | Convex Auth JWT-issuer config (Phase-0 scaffold). |
| `actions.example.ts` | **Reference exemplar** of the action pattern (not shipped logic). |

## The domain-normalization contract (depended on by every lane)

`lib/domain.ts` is the only sanctioned way to produce a domain/URL key. A
non-normalized key is the #1 silent-join-failure mode (`company` ↔ `page` ↔
`measurement` break invisibly). Exact behavior — rely on it for exact-match:

- **`normalizeDomain(input)` → registrable domain (eTLD+1).** The `company.domain`
  key. Accepts a **bare host OR a full URL** and returns the same key
  (`acme.com` and `https://www.Acme.com/pricing?utm=x` both → `acme.com`).
  Lowercases, strips `www` **and all subdomains** (`docs.acme.com` → `acme.com`),
  drops port/userinfo, collapses http/https. Multi-label suffixes are respected
  (`blog.acme.co.uk` → `acme.co.uk`, not `co.uk`) via a hardcoded subset — see
  the LIMITATION note in the file. **P2 must call this on citation source URLs**
  so they collide with `company.domain`.
- **`normalizeUrl(input)` → canonical page key.** Used by `page.url` **and**
  `measurement.page_url` (they must collide). Forces https, strips `www` but
  **keeps meaningful subdomains** (`docs.` ≠ root), keeps the path (case
  preserved) minus a trailing slash, drops the fragment and tracking params
  (`utm_*`, `gclid`, `fbclid`, …), sorts remaining params.
- Both are **idempotent**. Live **redirect resolution** belongs in the action
  layer (network); these pure helpers only do deterministic alias collapse.

Tested in `../platform/tests/domain.test.ts` (17 cases) — runs in CI.

## The action pattern (every external side-effect)

```
queries   = pure reads (reactive, no I/O)
mutations = pure writes (transactional, no I/O) — keys are normalized HERE
actions   = the ONLY place external I/O happens; actions call queries/mutations
            via ctx.runQuery / ctx.runMutation, never the DB directly
```

So an engine/scrape/analysis call lives in an **action**, which then persists via
a **records.ts mutation** — meaning even an action can't smuggle a raw key into
the store. Copy `actions.example.ts`. Secrets live in Convex env
(`npx convex env set OPENAI_API_KEY …`), never in the client, never in a
query/mutation.

## Writing records (P2/P3/P4)

Call the mutations in `records.ts` (`upsertCompany`, `upsertPage`,
`insertQuery`, `insertMeasurement`, `insertModelFit`, `upsertExperiment`,
`insertLiftResult`, `insertIntervention`). They normalize keys and scope to the
workspace for you. Develop against the seed fixtures in
[`../tests/integration/fixtures/`](../tests/integration/fixtures/) until the
upstream lane writes real rows.

## Running it (human step — needs Convex credentials)

```
npm install
npx convex dev          # generates convex/_generated/ + a deployment URL
# put the printed URL in platform/.env as VITE_CONVEX_URL
npm run dev -w platform # the live board
```

`convex/_generated/` is created by codegen (not committed here). CI does **not**
deploy Convex — it runs the pure-TS unit tests only (cost + determinism).
