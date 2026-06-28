# convex/ — Convex backend (owned by P1)

The reactive backend: the **schema** (the 9 records from `../docs/CONTRACT.md`), queries/mutations (pure), and **actions** (all external side-effects — engine calls, enrichment, the Python analysis service, CMS publish — go through actions and write back to records). Also the scheduler/cron (monthly baseline re-measurement, experiment slot expiry, event-driven re-measurement on publish).

Phase 0: fork the **SignalDesk** template (convex.link/growthdemo), implement the schema, and the domain-normalization helper that every lane uses for keys.

> The schema here is the code form of `../docs/CONTRACT.md`. Changing it requires all-owner sign-off (see `../ORCHESTRATION.md` §4).
