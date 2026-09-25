# Decision MVP 2 — regression baseline (M2-01)

Locks the MVP 1 golden path as the regression contract before MVP 2 work begins,
per the MVP 2 plan §27 work package M2-01. Any MVP 2 change that breaks a row
here is a regression — fix the change, not the baseline.

## Pinned commit

| Item | Value |
|---|---|
| Baseline tag | `decision-mvp1-baseline` |
| Tagged commit | `9617ceca` (`fix(decision): roll back status and mark run failed when resolve throws` — PR #19) |
| Frozen on | 2026-09-25 |
| Foundation | TREK v4.3.1 clean fork + MVP 1 vertical slice (VS-01→VS-14) + fixes #14–#19 |

## The regression contract

```text
Dashboard → /decision/new → technical TREK trip + DecisionSession (COLLECTING)
Host invite → anonymous participant join (/d/<token>, no TREK account)
→ scoped participant session → context submission → realtime host roster
Host candidate add → resolver → Top 3 → select → reload persistence
```

Must not break:

- anonymous participant flow (no TREK account, scoped participant token);
- DecisionSession persistence across reloads;
- realtime `decision:*` updates (participant/candidate/recommendation/selected);
- synchronous resolver path + `resolve` rollback on failure;
- selection persistence (`decision_selections`, re-select replaces);
- reload recovery (`decisionRepo.open` coherent snapshot + `eventSeq` race guard).

## Coverage — where each contract line is proven

| Contract | Proof |
|---|---|
| create → invite → join → resolve → select (anonymous, realtime, reload) | `client/e2e/decision.spec.ts` — Playwright golden path |
| resolve pipeline (constraints, fairness, Top-N, rollback) | `server/tests/unit/nest/decision.resolver.test.ts` |
| room lifecycle + selection + feedback + funnel events | `server/tests/unit/nest/decision.service.test.ts`, `decision.controller.test.ts` |
| schema/migrations incl. `revoked_at` backfill | `server/tests/unit/db/decision-schema-migration.test.ts` |
| reconnect snapshot race + selection reload | `client/src/repo/decisionRepo.test.ts`, `client/src/store/decisionStore.test.ts` |
| `/d/` auth-interceptor allowlist | `client/tests/unit/api/client.interceptor.test.ts` |

## Baseline gate results (run on the tagged commit)

| Gate | Command | Result |
|---|---|---|
| Playwright golden path | `cd client && npx playwright test e2e/decision.spec.ts` | 2 passed (38.8s) |
| Resolver + controller unit tests | `cd server && npx vitest run tests/unit/nest/decision.resolver.test.ts tests/unit/nest/decision.controller.test.ts` | 19 passed |
| Schema migrations | `cd server && npx vitest run tests/unit/db/decision-schema-migration.test.ts` | 8 passed |
| Typecheck | `npm run typecheck` (shared, server, server tests, client) | clean |
| Screen-recorded demo | full golden path incl. 2 anonymous participants + participant result views | passed (3 bugs found, fixed in #17/#18/#19) |

## Known non-blocking gaps at freeze

- Place candidates are quick-add (`name + lat + lng`); real TREK Places search lands in M2-02.
- Travel matrix is the deterministic mock provider; the real provider lands in M2-05.
- Participant `travel_mode` exists in the shared contract but is not yet persisted/used.
- No map comparison, votes, VenueContext, or host notifications yet (M2-08+).
