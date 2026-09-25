---
name: testing-trek-decision
description: How to demo/test the TREK Decision ("chốt quán") group-venue-chooser feature — dev startup, seeded creds, anonymous-participant incognito pattern, and stale-DB pitfalls.
---

# Testing the TREK Decision room ("chốt quán")

## Setup
- Run `npm run dev` at repo root — builds `shared/`, then watches server (:3001) + client (Vite :5173, proxies /api + /ws). Wait for "Nest application successfully started" AND the vite port before browsing.
- Dev login: a seeded `smoke@test.dev` exists in this checkout's local dev DB (`server/data/travel.db`, gitignored) — its password lives only in session secrets, never in the repo. If it is missing from your DB, register a fresh account through the signup form and use that instead; the host flow needs any account. Admin exists as `admin` but `must_change_password=1` — avoid it for demos.
- SQLite dev DB: `server/data/travel.db` (better-sqlite3; readable while the server runs — queries serialize through WAL).

## Feature map (v4.3.1 + decision domain)
- Dashboard "My Trips" header has a coffee-cup button (`aria-label="Chốt quán"`) → `/decision/new` → creates a session 1:1 on a NEW technical trip → lands `/decision/<id>` (ProtectedRoute).
- The technical trip starts EMPTY → the place-picker chips won't appear; use the quick-add row ("Tên quán mới" + lat/lng + "Thêm") to create candidates. Provide real lat/lng — the mock travel matrix only computes haversine×1.3/mode-speed and (0,0)/missing coords yield `không rõ`/`no_route`.
- "Link mời nhóm" mints `${origin}/d/<token>` (POST /api/decisions/:id/invites) and tries `navigator.clipboard.writeText` — clipboard may silently fail (code swallows it); the link text stays visible to copy manually.
- `/d/:token` is a PublicRoute anonymous participant flow: preview → display name → one intake form (origin label+coords, max travel, budget ₫, ≤3 prefs, veto) → waiting (polls /api/decision-participant/result every 3s) → Top-3 result with the participant's own travel time.
- Participant credential = scoped bearer token in sessionStorage (`decision_participant_token`) — so a SECOND participant needs a NEW tab (fresh sessionStorage), not a reload of the same tab.
- Host page joins the technical trip's WS room; `decision:participant-joined/updated`, `decision:candidate-added`, `decision:status-updated`, `decision:selected`, `decision:recommendation-ready` update the store live (no reload).
- Resolve is synchronous: "Tìm quán phù hợp nhất" → POST /api/decisions/:id/resolve returns the RecommendationResult. Enabled only when ≥1 candidate AND ≥1 participant.
- Select: "Chọn quán này" on an eligible item → status `selected` ("Đã chốt"), Điều hướng link + feedback form.

## Two-context pattern for anonymous joins
- Incognito window = `Ctrl+Shift+N`; a second seat = a NEW incognito tab (per-tab sessionStorage). Switch windows with `wmctrl -l` + `wmctrl -i -a <id>` (faster + more reliable than Alt+Tab on this box).
- Watch for the 401 interceptor: `isAuthPublicPath` in `client/src/api/client.ts` redirects any 401 AUTH_REQUIRED on non-whitelisted paths to /login — anonymous pages must be whitelisted or they bounce.

## Stale-DB pitfall (this checkout's history)
- The decision migration was edited in place during development; DBs created earlier carry the OLD table shapes → runtime 500s ("no such column: revoked_at", "ON CONFLICT ... no UNIQUE constraint", "no such table: recommendation_runs"). Symptoms-only fix: re-run the migration's `CREATE TABLE IF NOT EXISTS`/`CREATE INDEX` blocks verbatim (idempotent) + `ALTER TABLE` for missing columns + drop/recreate wrongly-shaped empty tables.
- A crashed resolve leaves `decision_sessions.status='resolving'` which is NOT resolvable (server guard + client button list) — manually `UPDATE decision_sessions SET status='collecting'` to un-wedge before retrying.

## Devin Secrets Needed
- None for this feature. (OCP_SOLVER_API_KEY is unrelated — it's for an external solver service, not TREK.)
