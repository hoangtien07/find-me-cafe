# Decision baseline freeze

Records the TREK baseline the Decision product builds on, per
`IMPLEMENTATION_PLAN.md` Phase 0. No decision code lands until this file
records `BASELINE_GREEN = true`.

## Upstream pin

| Item | Value |
|---|---|
| Upstream repo | `liketrek/TREK` |
| Upstream HEAD at freeze | `ed8acf4c4b642bcf4975f8d1ee43801fb3b65941` (`chore: bump version to 4.3.1 [skip ci]`) |
| Product repo | `hoangtien07/find-me-cafe` |
| Local `main` at freeze | identical to upstream HEAD — clean fork point |
| Frozen on | 2026-09-24 |
| TREK version | 4.3.1 |
| Toolchain | Node 24 (CI tests 22 + 24; Dockerfile node:24) |

## Baseline gate results (run on the frozen commit)

| Gate | Command | Result |
|---|---|---|
| Install | `npm install` | ok (1410 pkgs) |
| Build | `npm run build` | ok (shared → server → client) |
| Typecheck | `npm run typecheck` (shared, server, server tests, client) | ok |
| Shared tests | `npm run test --workspace=shared` | 749 passed |
| Server tests | `npm run test --workspace=server` | 12624 passed / 22 skipped |
| Server e2e | `npm run test:e2e` | passed |
| Client tests | `npm run test --workspace=client` | 15868 passed / 38 skipped |
| Lint | `npm run lint` | 0 errors (1427 pre-existing warnings) |
| i18n parity | `npm run i18n:parity:strict --workspace=shared` | OK |

## Local environment smoke (`npm run dev`, server :3001 + vite :5173)

Verified end-to-end on a fresh dev DB:

- register + login (`trek_session` cookie + JWT) — ok
- create trip (POST /api/trips) — ok
- place search (POST /api/maps/search, built-in `trek-places` provider) — ok
- add + list places — ok
- owner-managed guest member (POST /api/trips/:id/guests, `is_guest=1`) — ok
- WebSocket (`/ws?token=` → `welcome` + `joined` trip room) — ok
- PWA client serves (title + `manifest.webmanifest`) — ok

Docker: daemon present; `npm run dev` used as the local environment
(`docker-compose.yml` is the deployment path, unchanged).

## Result

```text
BASELINE_GREEN = true
```

Rebase policy: update from upstream only after the vertical slice has a green
regression suite (plan Phase 23.10).
