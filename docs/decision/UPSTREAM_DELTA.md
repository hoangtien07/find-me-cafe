# Upstream delta log

Every unavoidable edit to existing TREK (upstream `liketrek/TREK`) code lands
here, per `IMPLEMENTATION_PLAN.md` Phase 23 rule 9. New files in new
directories (`shared/src/decision/`, `server/src/nest/decision/`, decision
client files) are additive and do not count as upstream edits; edits to files
that exist upstream do.

## Format

| When | File | Change | Why unavoidable |
|---|---|---|---|
| #13 | `shared/src/index.ts` | barrel re-export of the decision contract module | domain contract must be importable from `@trek/shared` |
| #13 | `shared/src/realtime/events.schema.ts` | `decision:*` entries in the WS event registry | the registry is a single flat map; parity ratchet requires registration |
| #13 | `shared/src/realtime/events.schema.spec.ts` | fixture entries + pinned registry counts | spec pins exact counts |
| #13 | `client/src/api/wsEventPolicy.ts` | `decision:*` in `HANDLED_OUTSIDE_TRIP_STORE` | client must declare a handler decision per registered event |
| #3 | `server/src/db/migrations.ts` | appended migration creating the decision tables | migrations are append-only, positional |
| #18 | `server/src/db/migrations.ts` | appended `revoked_at` backfill migration | old-shape installs need a guarded backfill; still append-only |
| #4 | `server/src/nest/app.module.ts` | `DecisionModule` registration | a Nest module must register on the app |
| #5 | `server/src/nest/common/validate-route-guards.ts` | invite preview/join → `PUBLIC_ROUTE_ALLOW_LIST`; participant routes → `ANONYMOUS_GUARDED_ROUTE_ALLOW_LIST` | default-deny ratchet — exact entries, never a broad exemption |
| #12 | `client/src/App.tsx` | `/d/:token` + `/decision/:id` routes | the client route table is an upstream file |
| #12 | `shared/src/i18n/<locale>/decision.ts` | decision-domain locale files in every locale | i18n lives in shared; parity demands real translations |
| #12 | `client/src/pages/DashboardPage.tsx` | "Chốt quán" entry point | the product shell's main entry |
| #17 | `client/src/api/client.ts` | `/d/` in the 401-redirect allowlist | anonymous invite links bounced to /login without it |
| #23 | `server/src/app-config/env.schema.ts` | `DECISION_MATRIX_PROVIDER` + `GOOGLE_ROUTES_*`/`OSRM_*` vars | env access goes through app-config only |
| #23 | `server/src/app-config/derive.ts` | `deriveDecision` matrix keys | same ratchet |
| #23 | `server/.env.example` | matrix-provider env docs | the env reference doc |
| #30 | `server/src/app-config/env.schema.ts` | `vietmap` in provider enum + `VIETMAP_*` vars | same ratchet |
| #30 | `server/src/app-config/derive.ts` | vietmap key/base in `deriveDecision` | same ratchet |
| #30 | `server/.env.example` | vietmap env docs | same doc |

## Known upcoming upstream touches (planned, minimal)

- `shared/src/index.ts` — barrel re-export of the decision contract module
  (one line per file; the established pattern for a new domain contract).
- `shared/src/realtime/events.schema.ts` — 7 `decision:*` entries in the WS
  event registry (the registry is intentionally a single flat map).
- `shared/src/realtime/events.schema.spec.ts` — fixture entries + pinned
  registry counts (74→81 trip, 106→113 total).
- `client/src/api/wsEventPolicy.ts` — `decision:*` entries in
  `HANDLED_OUTSIDE_TRIP_STORE` (the parity ratchet requires a client decision
  for every registered event).
- `server/src/db/migrations.ts` — appended migration creating the 12 decision
  tables (append-only; positional identity preserved).
- `server/src/nest/app.module.ts` — `DecisionModule` import + registration.
- `server/src/nest/common/validate-route-guards.ts` — exact entries in
  `PUBLIC_ROUTE_ALLOW_LIST` (invite preview/join) and
  `ANONYMOUS_GUARDED_ROUTE_ALLOW_LIST` (participant-token routes). Deliberate
  ratchet entries; never a broad `/api/decisions/*` exemption.
- `server/src/addons.ts` — optional `ADDON_IDS.DECISIONS` if the addon flag
  lands (decision on file before it does).
- Client route table — `/d/:decisionId` and `/j/:inviteToken` routes.
- `shared/src/i18n/<locale>/` — decision-domain locale files (real
  translations in every locale; `en` canonical).
