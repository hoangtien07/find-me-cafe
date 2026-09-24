# TREK Decision Implementation Plan V1

**Input:** `TREK_DECISION_PRODUCT_SPEC_V1.md`  
**Goal:** Implement the smallest end-to-end Place Decision vertical slice on top of TREK without rewriting TREK's platform kernel.

---

## 0. Implementation strategy

We are not redesigning TREK first.

We will implement one new bounded context and prove it through an end-to-end slice.

Sequence:

```text
Baseline
→ contracts
→ schema
→ decision backend
→ participant-token boundary
→ host UI
→ participant UI
→ mocked matrix
→ deterministic resolver
→ realtime host updates
→ selection
→ telemetry
→ real routing
→ VenueContext
```

Do not begin with visual redesign, AI, or place-data enrichment.

---

# Phase 0 — Freeze TREK baseline

## Goal

Establish a known-good foundation before product changes.

## Tasks

1. Clone / update TREK.
2. Record current upstream commit SHA in `docs/decision/BASELINE.md`.
3. Run root build, root tests, server/client typecheck, server unit/integration/e2e, client tests, lint, i18n parity.
4. Start Docker/local environment.
5. Verify login, create trip, place search, add place, member/guest behavior, WebSocket, PWA client.

## Exit criteria

```text
BASELINE_GREEN = true
```

No decision code until baseline is green.

---

# Phase 1 — Add Decision contracts

Create:

```text
shared/src/decision/
  decision.schema.ts
  decision-events.schema.ts
  index.ts
```

Define schemas for:

```text
DecisionSession
DecisionInvite
DecisionParticipant
ParticipantContext
DecisionCandidate
RecommendationRun
RecommendationCandidate
DecisionSelection
DecisionFeedback
```

Define request schemas:

```text
CreateDecisionRequest
UpdateDecisionRequest
CreateDecisionInviteRequest
JoinDecisionRequest
UpdateParticipantContextRequest
AddDecisionCandidateRequest
ResolveDecisionRequest
SelectDecisionRequest
CreateDecisionFeedbackRequest
```

Add typed events:

```text
decision:participant-joined
decision:participant-updated
decision:candidate-added
decision:candidate-removed
decision:status-updated
decision:recommendation-ready
decision:selected
```

Update event-registry parity tests immediately.

## Exit criteria

- shared package builds;
- schema tests pass;
- client/server import inferred types;
- event registry parity passes.

---

# Phase 2 — Add database schema

Do **not** modify existing trip shape yet.

Create Decision tables through append-only migrations:

```text
decision_sessions
decision_invites
decision_participants
decision_participant_sessions
decision_preferences
decision_constraints
decision_candidates
decision_travel_estimates
recommendation_runs
recommendation_scores
decision_selections
decision_feedback
```

Important constraints:

```text
decision_sessions.trip_id UNIQUE

decision_candidates:
UNIQUE(decision_session_id, place_id)

decision_travel_estimates:
UNIQUE(decision_session_id, participant_id, candidate_id, travel_mode)
```

Token tables store hashes only.

Add indexes on session/participant/candidate/run foreign keys.

## Exit criteria

- migration applies to an existing TREK DB;
- clean install works;
- FK / unique tests pass;
- backup/restore remains functional.

---

# Phase 3 — Add native Decision Nest module

Create:

```text
server/src/nest/decision/
  decision.module.ts
  decision.controller.ts
  decision-public.controller.ts
  decision.service.ts
  decision.repository.ts
  decision.dto.ts

  decision-invite.service.ts
  decision-participant-auth.service.ts

  decision-candidate.service.ts

  resolver/
    resolver.service.ts
    constraint-engine.ts
    fairness-engine.ts
    ranking-engine.ts
    explanation-engine.ts
    resolver.types.ts

  travel/
    travel-matrix.provider.ts
    mock-travel-matrix.provider.ts
    travel-matrix.service.ts

  decision.helpers.ts
```

Register `DecisionModule` in `AppModule`.

Optionally add:

```text
ADDON_IDS.DECISIONS = 'decisions'
```

enabled by default in this product distribution.

Rules:

- controller thin;
- business logic injectable;
- SQL in repository;
- no direct `process.env`;
- multi-statement writes in transactions;
- Zod DTOs from `@trek/shared`.

---

# Phase 4 — Create Decision Room atomically

Endpoint:

```text
POST /api/decisions
```

Authenticated host only.

Transaction concept:

```text
BEGIN
create technical TREK trip
create decision_session(trip_id)
insert host-related decision metadata
COMMIT
```

Do not manually duplicate TREK trip creation behavior if an injectable service can be reused safely.

If `TripsService.create()` has too many itinerary-specific side effects, extract/reuse a narrow technical trip-creation primitive rather than copying SQL.

V1 request:

```json
{
  "title": "Tối nay đi đâu?",
  "occasion": "hangout",
  "scheduledAt": "..."
}
```

## Exit criteria

- host creates room;
- technical trip access works;
- normal trip behavior remains unaffected.

---

# Phase 5 — Anonymous participant security boundary

This is the most important new security work.

## 5.1 Decision invite

Authenticated host:

```text
POST /api/decisions/:id/invites
```

Generate cryptographically random token, persist only SHA-256 hash, return plaintext once.

## 5.2 Invite preview

Public:

```text
GET /api/decision-invites/:token
```

Return minimum metadata only.

## 5.3 Join

Public:

```text
POST /api/decision-invites/:token/join
```

Create:

```text
decision_participant
decision_participant_session
```

Return a scoped participant token.

## 5.4 Participant guard

Create:

```text
DecisionParticipantGuard
```

It validates token, expiry, revoke state, and exact DecisionSession scope.

## 5.5 Public route ratchet

Add only exact public routes to TREK's approved allow-list. Never mark broad `/api/decisions/*` public.

Required tests:

- invalid token;
- expired token;
- revoked token;
- token from Decision A used on B;
- malformed ID;
- closed session;
- update after revoke.

---

# Phase 6 — Participant context

Endpoint:

```text
PUT /api/decision-participant/context
```

V1 context:

```text
origin
maxTravelMinutes
budgetMin / budgetMax
topPreferences[]
dealBreakers[]
```

On write:

1. validate;
2. transaction;
3. update participant;
4. update preferences / constraints;
5. broadcast `decision:participant-updated` to host through existing `RealtimeService`.

Anonymous participant itself does not need WebSocket.

---

# Phase 7 — Candidate integration

Reuse TREK Places.

Host uses existing TREK search/maps flow.

Decision endpoint:

```text
POST /api/decisions/:id/candidates
```

Input:

```text
placeId
```

Validate host access, trip ownership of Place, and duplicates.

When adding a candidate, snapshot relevant fields:

```text
name
lat/lng
address
provider ids
rating metadata if present
opening-hours evidence if present
price if present
```

This preserves recommendation reproducibility.

---

# Phase 8 — TravelMatrixProvider with mock first

Interface:

```ts
interface TravelMatrixProvider {
  compute(input: TravelMatrixInput): Promise<TravelMatrixResult>;
}
```

Implement first:

```text
MockTravelMatrixProvider
```

Use deterministic fixture travel times.

Required tests:

- participant missing origin;
- candidate missing coordinates;
- partial matrix;
- no route;
- provider error;
- deterministic fixture.

The goal is to prove the domain pipeline before choosing/optimizing a routing provider.

---

# Phase 9 — Resolver V1

## 9.1 Hard constraints

Pure function:

```text
evaluateConstraints(candidate, session)
```

Output:

```json
{
  "eligible": true,
  "violations": [],
  "unknowns": []
}
```

V1 hard rules:

- explicit hard max travel;
- explicit hard budget if candidate price is known;
- explicit veto;
- reliable closed-at-time evidence.

UNKNOWN never becomes PASS.

## 9.2 Fairness

Input:

```text
durations[]
participant limits[]
strategy config
```

Metrics:

```text
mean
max
min
range
variance
limitViolationCount
```

V1 strategy: `HYBRID`, strongly penalizing worst-member travel, hard-limit violations, and high inequality.

## 9.3 Ranking

Dimensions:

```text
TravelFairness
GroupPreferenceFit
ContextFit
PlaceQuality
Trust
```

Normalize internally; do not expose fake percentages.

## 9.4 Versioning

Store:

```text
strategy_version = "resolver-v1"
```

Never overwrite historical score rows when algorithm changes.

## 9.5 Explanation

Generate structured output:

```json
{
  "headline": "Cân bằng nhất cho nhóm",
  "strengths": [],
  "tradeoffs": [],
  "travelTimes": []
}
```

No LLM required.

---

# Phase 10 — Resolve endpoint

```text
POST /api/decisions/:id/resolve
```

Process:

```text
load session
load participant contexts
load candidates
validate minimum inputs
compute/load travel matrix
constraint engine
feature extraction
fairness engine
ranking
persist recommendation run + scores
mark RESOLVED
broadcast decision:recommendation-ready
```

Use TREK `X-Idempotency-Key` support.

Also compute `input_hash` so identical inputs can be recognized.

---

# Phase 11 — Host client

Create:

```text
client/src/api/decision.ts
client/src/repo/decisionRepo.ts
client/src/store/decisionStore.ts
client/src/pages/DecisionPage.tsx
client/src/pages/decision/useDecisionPage.ts
client/src/components/Decision/
```

Host UI V1:

```text
Decision title

Participants
✓ An
✓ Bình
… Chi

Candidates
Cafe A
Cafe B
Cafe C

[ Find best match ]
```

After resolve:

```text
#1 ...
#2 ...
#3 ...

[ Chốt quán ]
```

Respect TREK Page pattern; keep stateful logic out of `DecisionPage.tsx`.

---

# Phase 12 — Participant client

Dedicated public route, e.g.:

```text
/j/:inviteToken
```

Flow:

```text
invite preview
→ display name
→ join
→ origin
→ max travel
→ budget
→ 1–3 preferences
→ deal breaker
→ submit
→ success
```

Target completion: `<45s`.

Do not expose ordinary TREK dashboard/navigation.

---

# Phase 13 — Realtime host progress

Add typed WebSocket events to host's existing trip room.

At minimum:

```text
decision:participant-joined
decision:participant-updated
decision:candidate-added
decision:candidate-removed
decision:recommendation-ready
decision:selected
```

Client handling must participate in TREK's shared registry parity discipline.

---

# Phase 14 — Selection and outcome

Select:

```text
POST /api/decisions/:id/select
```

Persist `decision_selections`, broadcast `decision:selected`, then allow navigation/deep-link.

Feedback V1:

```text
fitScore 1..5
wouldChooseAgain
regretReason
```

No long survey.

---

# Phase 15 — Decision telemetry

Record product events separately from WebSocket events:

```text
DECISION_CREATED
INVITE_CREATED
PARTICIPANT_JOINED
PARTICIPANT_CONTEXT_SUBMITTED
CANDIDATE_ADDED
RESOLVE_STARTED
RESOLVE_COMPLETED
RECOMMENDATION_VIEWED
VENUE_SELECTED
NAVIGATION_OPENED
FEEDBACK_SUBMITTED
```

This is the initial DecisionGraph. Do not build ML yet.

---

# Phase 16 — Replace mock matrix with real provider

Only after the vertical slice passes.

Implement adapters behind `TravelMatrixProvider`.

Required characteristics:

- one production provider first;
- cache;
- timeout;
- response validation;
- explicit partial-failure cells;
- provider metadata.

Resolver must remain provider-neutral.

---

# Phase 17 — VenueContext V1

Create after real matrix works:

```text
server/src/nest/venue-context/
shared/src/venue-context/
```

Only fields that affect filter/ranking/explanation.

Do not scrape social networks for V1.

Candidate ranking reads:

```text
TREK Place + VenueContext
```

---

# Phase 18 — Product shell reduction

Only after the decision vertical slice is stable.

Landing:

```text
Đi đâu hôm nay?

[ Chốt quán cho nhóm ]
[ Tìm quán hợp vibe ]
[ Đi ngay gần đây ]
```

Do not delete travel modules. Hide/de-emphasize them in the consumer shell so upstream maintenance stays manageable.

---

# Phase 19 — Optional TREK poll integration

TREK Polls can be used after resolver:

```text
Resolver
→ Top 3
→ optional final vote
```

A poll records votes; it does not replace constraint/fairness resolution.

---

# Phase 20 — Testing plan

## Unit

- token hashing / validation;
- invite expiry;
- participant scope;
- constraints;
- fairness;
- ranking;
- explanations;
- venue key;
- matrix aggregation.

## Integration

- create Decision Room;
- join anonymously;
- submit context;
- add candidate;
- resolve;
- select;
- feedback;
- transaction rollback.

## Security

- cross-session participant token;
- host without trip access;
- participant reading data outside their scope;
- malformed/brute-force invite token;
- expired/revoked token;
- public-route allow-list.

## WebSocket

- host receives decision events;
- unauthorized user cannot join technical trip room;
- participant update emits exactly one typed event.

## Client

- host page hook;
- participant join flow;
- Top 3 rendering;
- UNKNOWN data presentation;
- selection.

## E2E

```text
host login
→ create decision
→ copy invite
→ participant joins
→ submits context
→ host adds candidates
→ resolve
→ select
```

---

# Phase 21 — First vertical slice backlog

Implement in exactly this order:

1. **VS-01 Contracts** — Decision schemas + tests.
2. **VS-02 DB** — Decision tables + migration tests.
3. **VS-03 Backend room** — authenticated create/get.
4. **VS-04 Invite boundary** — create invite + anonymous join + participant guard.
5. **VS-05 Participant context** — origin/preference.
6. **VS-06 Candidate** — attach existing TREK Places.
7. **VS-07 Mock matrix** — provider abstraction + fixture.
8. **VS-08 Resolver** — constraints + fairness + Top 3.
9. **VS-09 Host page** — participants + candidates + resolve.
10. **VS-10 Participant page** — join + input + submit.
11. **VS-11 Realtime** — host progress/result updates.
12. **VS-12 Selection** — persist + navigation.
13. **VS-13 Telemetry** — Decision events.
14. **VS-14 E2E** — happy-path Playwright.

---

# Phase 22 — Explicitly deferred backlog

Do not allow these into the first vertical slice:

```text
AI chat
LLM ranking
semantic search
TikTok
Threads
Google review ingestion pipeline
fresh crowd network
taste profile
friend graph
native mobile app
merchant portal
booking
payment
loyalty
large ontology
automatic nationwide enrichment
```

---

# Phase 23 — Upstream-maintainability rules

1. Add new modules instead of rewriting existing modules.
2. Prefer composition over edits to large existing services.
3. Keep public TREK contracts backward-compatible where possible.
4. Avoid renaming core tables/routes.
5. Avoid deleting unused travel modules.
6. Store product-specific state in Decision tables.
7. Reuse Maps/Places/Realtime through injected services.
8. Record every unavoidable core edit.
9. Maintain `docs/decision/UPSTREAM_DELTA.md`.
10. Update/rebase from TREK only after the vertical slice has a green regression suite.

---

# Phase 24 — Codex implementation instruction

Do not implement the whole plan in one pass.

Use one worktree/branch for the vertical slice.

Before each task:

1. inspect current source;
2. identify the existing TREK pattern;
3. implement the smallest change;
4. add tests;
5. run targeted tests;
6. run typecheck;
7. update the execution log.

The coding agent must not invent a second architecture alongside TREK.

TREK source conventions win when they conflict with assumptions in this document.

---

# Final implementation gate

The first milestone is complete only when:

```text
Host creates room
        ↓
anonymous participants join
        ↓
submit context
        ↓
host adds 3 places
        ↓
mock travel matrix
        ↓
deterministic resolver
        ↓
Top 3 explanation
        ↓
selection
        ↓
navigation
```

works end-to-end with tests and without breaking existing TREK behavior.

After that:

```text
Mock Matrix
→ Real Matrix
→ VenueContext
→ Contextual Discovery
→ Decision Learning
→ Fresh Signals
```

That is the shortest path from TREK foundation to the product thesis.
