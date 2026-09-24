# Upstream delta log

Every unavoidable edit to existing TREK (upstream `liketrek/TREK`) code lands
here, per `IMPLEMENTATION_PLAN.md` Phase 23 rule 9. New files in new
directories (`shared/src/decision/`, `server/src/nest/decision/`, decision
client files) are additive and do not count as upstream edits; edits to files
that exist upstream do.

## Format

| When | File | Change | Why unavoidable |
|---|---|---|---|
| _pending_ | — | — | — |

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
