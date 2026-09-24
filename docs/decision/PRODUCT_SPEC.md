# TREK Decision Product Spec V1

**Status:** Foundation frozen on TREK  
**Base:** `liketrek/TREK` (current source snapshot inspected on 2026-09-24)  
**Product direction:** Place Decision Engine for young urban users in Vietnam, starting with cafés / drink venues  
**Hero wedge:** Group Decision Resolver  
**Core capability:** Contextual place recommendation  
**Later moat:** DecisionGraph + VenueContext + Fresh Local Signals

---

## 1. Product thesis

The product is **not** a café directory and is **not** a smaller Google Maps.

Its job is:

> Turn “where should we go?” into a concrete, explainable group decision with minimum coordination effort.

The first strong use case is a group of 2–6 people choosing a café / drink venue with conflicting constraints such as different starting locations, maximum acceptable travel time, budget, occasion / vibe, drink preference, parking / seating / noise / laptop needs, and explicit vetoes.

The product should normally return a **small decision set (Top 3)** rather than a large map result set.

---

## 2. Why TREK is the foundation

TREK already provides most expensive platform primitives:

- React 19 + Vite + PWA client;
- NestJS backend;
- shared Zod contracts;
- SQLite / `better-sqlite3`;
- real-time WebSocket infrastructure;
- trip membership and permissions;
- accountless guest records;
- place search / maps / place enrichment;
- Google / OSM / TREK Places integration;
- route capabilities;
- collaborative polls;
- offline-first Dexie + mutation queue;
- idempotent mutation replay;
- plugin system;
- addon system;
- Docker / self-hosting;
- Vitest / Playwright / CI quality gates.

We will **extend TREK's architecture instead of building a parallel architecture**.

---

## 3. Critical source-audit correction: TREK “guest” != self-service anonymous participant

TREK supports accountless guests, but source inspection shows that these guests:

- are credential-less `users` rows with `is_guest=1`;
- are created / renamed / removed by an authenticated trip owner;
- **cannot authenticate**;
- are excluded from normal auth flows;
- do not independently open an invite link and submit data.

TREK's ordinary join link for real members is login-required.

Therefore our viral group flow needs a new primitive:

> **DecisionParticipant + scoped participant access token**

We MUST NOT weaken TREK's global auth or make `is_guest` users generally authenticatable.

This is an intentional product-domain extension.

---

## 4. Core architectural rule

### Keep TREK as platform kernel

Reuse:

- Trip as technical collaboration container;
- authenticated host;
- Places;
- Maps;
- permissions;
- WebSocket broadcast for authenticated host;
- offline/PWA client architecture;
- storage / media;
- existing route and place providers;
- existing testing and contract discipline.

### Own the decision domain

New bounded context:

```text
DecisionSession
Participant
ParticipantContext
CandidateVenue
TravelMatrix
ConstraintEvaluation
RecommendationRun
CandidateScore
RecommendationExplanation
Selection
OutcomeFeedback
VenueContext
FreshSignal (later)
```

Do not put resolver logic into `TripsService`, `PlacesService`, or `CollabService`.

---

## 5. Do NOT add `trip_kind` in V1

V1 should avoid a wide mutation to the existing `trips` aggregate.

Use a 1:1 relation instead:

```text
trips.id
   │
   └── decision_sessions.trip_id UNIQUE
```

The existence of a `decision_sessions` row means the TREK trip is acting as a technical Decision Room container.

Benefits:

- less invasive upstream delta;
- avoids touching every trip schema / query / dashboard path;
- easy rollback;
- normal TREK trips remain unchanged;
- the decision domain can evolve independently.

A future `trip_kind` can be considered only if real usage shows a strong need.

---

## 6. Product shell

Users should not experience the ordinary TREK travel-planner information architecture as the main product.

Primary entry:

```text
Đi đâu hôm nay?

[ Chốt quán cho nhóm ]
[ Tìm quán hợp vibe ]
[ Đi ngay gần đây ]
```

For V1, prioritize:

> **Chốt quán cho nhóm**

A decision-specific route should be introduced, e.g.:

```text
/d/:decisionId
```

TREK's normal trip planner can remain available internally / separately.

---

## 7. Primary flow

```text
Authenticated Host
    │
    ├─ Create Decision Room
    │
    ├─ Occasion / time
    │
    ├─ Optional initial candidates
    │
    └─ Share decision invite URL
           │
           ▼
 Anonymous Participant
           │
           ├─ name
           ├─ origin
           ├─ max travel time
           ├─ budget
           ├─ top preferences
           └─ deal-breakers
           │
           ▼
 Candidate generation / shortlist
           │
           ▼
 Travel Matrix
           │
           ▼
 Hard constraints
           │
           ▼
 Group fairness + place fit
           │
           ▼
 Top 3 + explanations
           │
           ▼
 Group selection
           │
           ▼
 Navigation
           │
           ▼
 Outcome feedback
```

---

## 8. Authentication and participant access

### Host

V1 host may use normal TREK authentication.

Anonymous-host creation is explicitly **deferred** to keep V1 small.

### Participant

Participant does not need a TREK account.

Introduce:

```text
decision_invites
decision_participants
decision_participant_sessions
```

Recommended flow:

1. Host creates a decision invite.
2. Invite URL contains one opaque invite token.
3. Token is stored **hashed** server-side.
4. Participant opens invite, chooses a display name, and joins.
5. Server creates `decision_participant`.
6. Server issues a new, scoped participant access token.
7. Client stores this token for the current browser session.
8. Participant token only authorizes endpoints under that exact DecisionSession.
9. Invite and participant tokens can expire / be revoked.

Do not reuse TREK global JWT auth for anonymous participants.

Do not make TREK `is_guest` rows login-capable.

---

## 9. Realtime strategy

TREK WebSocket currently authenticates a real TREK user and checks access before joining a trip room.

For V1:

- authenticated host uses existing TREK WebSocket;
- anonymous participant submits over scoped REST;
- participant writes trigger `RealtimeService.broadcast(tripId, ...)`;
- host gets instant progress updates;
- anonymous participants do **not** require a WebSocket connection in V1.

Example:

```text
participant submits
    ↓
decision service persists
    ↓
broadcast(trip_id, "decision:participant-updated", ...)
    ↓
host UI updates immediately
```

This avoids weakening TREK WebSocket authentication.

Participant WebSocket support is later work only if behavior requires it.

---

## 10. Database model V1

### `decision_sessions`

```text
id
trip_id UNIQUE
status
occasion
scheduled_at
travel_mode
currency
created_by_user_id
created_at
updated_at
```

Suggested status:

```text
COLLECTING
READY
RESOLVING
RESOLVED
SELECTED
CLOSED
CANCELED
```

### `decision_invites`

```text
id
decision_session_id
token_hash
expires_at
revoked_at
created_by_user_id
created_at
```

### `decision_participants`

```text
id
decision_session_id
display_name
origin_lat
origin_lng
origin_label
max_travel_minutes
budget_min
budget_max
submitted_at
created_at
updated_at
```

### `decision_participant_sessions`

```text
id
decision_participant_id
token_hash
expires_at
revoked_at
created_at
```

### `decision_preferences`

```text
id
participant_id
key
value
weight
is_hard
```

### `decision_constraints`

```text
id
decision_session_id
participant_id nullable
type
operator
value_json
is_hard
```

### `decision_candidates`

```text
id
decision_session_id
place_id
source
added_by_type
added_by_id nullable
snapshot_json
created_at
```

`place_id` references TREK trip-scoped Place.

`snapshot_json` preserves important evidence at recommendation time.

### `decision_travel_estimates`

```text
id
decision_session_id
participant_id
candidate_id
travel_mode
distance_meters
duration_seconds
provider
computed_at
```

Unique:

```text
(decision_session_id, participant_id, candidate_id, travel_mode)
```

### `recommendation_runs`

```text
id
decision_session_id
strategy_version
status
input_hash
created_at
completed_at
```

### `recommendation_scores`

```text
id
recommendation_run_id
candidate_id

eligible
constraint_result_json

place_fit
group_fit
travel_fairness
context_fit
trust_score
total_score

rank
explanation_json
```

### `decision_selections`

```text
id
decision_session_id
candidate_id
recommendation_run_id nullable
selected_by_user_id nullable
selected_at
```

### `decision_feedback`

```text
id
decision_session_id
participant_id nullable
candidate_id
fit_score
would_choose_again
regret_reason nullable
feedback_json
created_at
```

---

## 11. Candidate venue identity

TREK Places are trip-scoped. The same physical venue can therefore appear in multiple trips.

VenueContext must not use only `places.id` as a global identity.

Canonical identity order:

```text
google_place_id
→ amap_poi_id
→ osm_id
→ provider-specific id
→ fallback normalized geospatial identity
```

Introduce a stable `venue_key` helper, not a second full Place model.

Example:

```text
google:ChIJ...
osm:node/123
amap:B000...
coords:<rounded-lat>:<rounded-lng>:<normalized-name>
```

---

## 12. VenueContext V1

Do not create a huge ontology.

Store only attributes that can affect filtering, ranking, or explanation.

```text
venue_key

price_band

noise_level
lighting
seating_style

laptop_friendliness
group_friendliness
date_friendliness
photo_friendliness

parking

drink_tags_json
vibe_tags_json
occasion_tags_json

confidence
evidence_json
updated_at
```

Each field should have explicit evidence / confidence where practical.

Base Place data remains TREK's responsibility.

VenueContext is our semantic overlay.

---

## 13. Travel Matrix

TREK has routing primitives but our decision problem requires:

```text
Origins × CandidateVenues
```

Introduce provider-neutral interface:

```ts
interface TravelMatrixProvider {
  compute(input: {
    origins: Coordinate[];
    destinations: Coordinate[];
    mode: TravelMode;
    departureAt?: string;
  }): Promise<TravelMatrixResult>;
}
```

V1 output cell:

```text
originIndex
destinationIndex
distanceMeters
durationSeconds
status
provider
```

Resolver MUST depend on this interface, never a specific routing vendor.

Cache matrix rows by normalized input and reasonable TTL.

---

## 14. Resolver V1

Resolver is deterministic and versioned.

Pipeline:

```text
candidate set
  ↓
hard constraint evaluation
  ↓
travel metrics
  ↓
place / context feature extraction
  ↓
group fairness
  ↓
ranking
  ↓
Top 3
  ↓
structured explanation
```

### Hard constraints

Examples:

```text
closed at intended time
explicit hard budget violation
participant travel time > hard max
explicit participant veto
missing mandatory venue capability
```

Unknown data is **UNKNOWN**, not PASS.

### Soft dimensions

```text
PlaceFit
GroupFit
TravelFairness
ContextFit
Trust
```

Conceptual score:

```text
Score =
  w_place   * PlaceFit
+ w_group   * GroupFit
+ w_travel  * TravelFairness
+ w_context * ContextFit
+ w_trust   * Trust
- penalties
```

Weights are configuration / strategy data, not hard-coded UI values.

---

## 15. Fairness engine

Track at minimum:

```text
mean travel time
maximum travel time
minimum travel time
range
variance
hard-max violations
```

Design strategies:

```text
MIN_SUM
MIN_MAX
MIN_VARIANCE
LEXIMIN
HYBRID
```

V1 default:

> HYBRID with strong penalty for extreme sacrifice by one participant.

Do not expose mathematical strategy names to normal users.

User-facing language:

- “Cân bằng nhất”
- “Nhanh nhất cho cả nhóm”
- “Không ai phải đi quá xa”

---

## 16. Recommendation explanation

Do not show fake precision such as:

```text
87.381% fit
```

Show evidence and trade-offs:

> **#1 — Cân bằng nhất cho nhóm**  
> An 16m · Bình 18m · Chi 17m · Dũng 20m  
> ✓ tất cả trong giới hạn di chuyển  
> ✓ hợp budget  
> ✓ phù hợp nói chuyện  
> **Đổi lại:** đồ uống ít nổi bật hơn lựa chọn #2.

Explanation engine should consume structured ranking evidence.

An LLM may later improve phrasing, but must not be the source of truth for ranking.

---

## 17. DecisionGraph

Every successful run should produce a learnable record:

```text
context
→ participants
→ candidates
→ ranking
→ selected venue
→ navigation intent
→ actual visit
→ satisfaction / regret
```

This dataset is more strategically valuable than generic ratings.

Do not use it for adaptive ranking until enough real behavior exists.

V1 simply records it.

---

## 18. Fresh signals — later

Not on MVP critical path.

Future model:

```text
FreshSignal
- venue_key
- type
- value
- source
- observed_at
- confidence
```

Types:

```text
CROWD
SEAT_AVAILABILITY
NOISE
QUEUE
RECENT_PHOTO
MERCHANT_STATUS
```

Resolver later adds `NowFit`.

No exact occupancy claim without trustworthy evidence.

---

## 19. API surface V1

Host-authenticated:

```text
POST   /api/decisions
GET    /api/decisions/:id
PATCH  /api/decisions/:id

POST   /api/decisions/:id/invites
POST   /api/decisions/:id/candidates
DELETE /api/decisions/:id/candidates/:candidateId

POST   /api/decisions/:id/resolve
GET    /api/decisions/:id/recommendations/latest
POST   /api/decisions/:id/select
POST   /api/decisions/:id/feedback
```

Public / participant scoped:

```text
GET    /api/decision-invites/:token
POST   /api/decision-invites/:token/join

GET    /api/decision-participant/session
PUT    /api/decision-participant/context
GET    /api/decision-participant/candidates
GET    /api/decision-participant/result
```

Participant routes require decision participant token, not TREK JWT.

Every public route must be explicitly allow-listed in TREK's default-deny public-route ratchet.

---

## 20. WebSocket events V1

Add shared typed registry events:

```text
decision:participant-joined
decision:participant-updated
decision:candidate-added
decision:candidate-removed
decision:status-updated
decision:recommendation-ready
decision:selected
```

Authenticated host receives these through the existing trip room.

Participant WebSocket is deferred.

---

## 21. Client architecture

Respect TREK client layering:

```text
Component
→ Decision feature hook
→ decisionStore / slice
→ decisionRepo
→ decisionApi | Dexie
```

Do not call Axios directly from Decision components.

Add:

```text
client/src/api/decision.ts
client/src/repo/decisionRepo.ts
client/src/store/decisionStore.ts
client/src/pages/DecisionPage.tsx
client/src/pages/decision/useDecisionPage.ts
client/src/components/Decision/*
```

For V1, anonymous participant flow can be online-only if explicitly documented.

Authenticated host's durable session/candidate state should follow TREK repo discipline.

---

## 22. Mobile-first UX

Primary mobile flow:

```text
Context
→ Participants
→ Candidates
→ Resolve
→ Result
→ Navigation
```

Do not port the entire TREK planner UI.

Shared hooks should contain business logic so desktop/mobile markup does not duplicate logic and fail Sonar duplication gates.

---

## 23. Existing TREK modules: Keep / Reuse / Hide

### Keep / reuse

```text
Auth
Trips technical container
Trip permissions
Maps
Places
Place enrichment
Realtime service
PWA
Offline core
Storage
Photos
i18n
Addons
Plugins
Audit
Idempotency
```

### Reuse selectively

```text
Collab Polls
Trip Members
TREK guest display model
route services
```

### Hide from main product shell

```text
Reservations
Flights
Packing
Travel budget
Journey
Atlas
Vacay
Files
long-trip itinerary UI
```

Do not delete them during MVP development.

---

## 24. MVP V1

MUST:

- host login;
- create Decision Room;
- share participant URL;
- anonymous participant join;
- origin;
- max travel;
- budget;
- top preferences;
- deal-breaker;
- add 2–6 candidate places;
- Travel Matrix;
- hard constraints;
- fairness;
- Top 3;
- structured explanation;
- select venue;
- open navigation;
- basic feedback;
- analytics / DecisionGraph events.

SHOULD:

- TREK place search to add candidates;
- basic VenueContext;
- host real-time participant progress;
- optional final poll.

LATER:

- natural-language context parsing;
- automatic candidate discovery;
- richer vibe graph;
- user taste profile;
- participant realtime sockets;
- fresh crowd signals;
- social evidence ingestion.

DO NOT BUILD YET:

- social feed;
- booking;
- payment;
- loyalty;
- creator marketplace;
- full review platform;
- TikTok / Threads crawler;
- exact real-time occupancy;
- native mobile app.

---

## 25. MVP success telemetry

Primary:

```text
successful_decision =
recommendation generated
AND venue selected
AND navigation opened
```

Track:

- time to decision;
- participants joined;
- participant completion;
- candidates viewed;
- recommendation-to-selection;
- selected rank;
- navigation open;
- outcome satisfaction;
- regret reason;
- next-session reuse.

---

## 26. Non-negotiable technical invariants

- Keep TREK default-deny auth.
- Public decision routes must have explicit scoped authorization.
- Never make normal TREK guests authenticatable.
- Keep Zod contracts in `shared/`.
- New server domain is a Nest module.
- New client writes follow repo / mutation discipline.
- Use DB transactions for multi-row mutations.
- Migrations remain append-only.
- Realtime event registry and client handler stay in parity.
- No raw `process.env` in server domain code.
- Do not bypass TREK storage / auth / permission abstractions.
- Maintain existing coverage and lint gates.
- Resolver strategy must be versioned.
- Recommendation evidence must be reproducible.

---

## 27. Vertical slice acceptance test

Foundation is considered technically proven when this works end-to-end:

1. Authenticated host creates Decision Room.
2. Server creates technical TREK Trip + DecisionSession atomically.
3. Host creates share link.
4. Two anonymous participants join without TREK accounts.
5. Each submits an origin and one preference.
6. Host adds three TREK Places as candidates.
7. A mocked TravelMatrixProvider returns participant × venue travel times.
8. Resolver runs deterministic V1 ranking.
9. Host sees Top 3 with explanations.
10. Host selects one.
11. Selection is persisted.
12. Host receives realtime participant/result events.
13. Tests cover auth boundary, invite token, constraint filtering, ranking, selection.
14. Existing TREK tests still pass.

Only after this vertical slice should real routing and richer VenueContext be integrated.

---

## 28. Source audit references

Key inspected TREK files:

- `CLAUDE.md`
- `server/CLAUDE.md`
- `client/CLAUDE.md`
- `server/src/nest/app.module.ts`
- `server/src/nest/trips/trips.module.ts`
- `server/src/nest/trip-members/trip-members.service.ts`
- `server/src/nest/realtime/realtime.gateway.ts`
- `server/src/nest/realtime/realtime.service.ts`
- `server/src/nest/maps/maps.controller.ts`
- `server/src/nest/maps/maps.service.ts`
- `server/src/nest/maps/trek-places.client.ts`
- `shared/src/trip/trip.schema.ts`
- `shared/src/place/place.schema.ts`
- `client/src/db/offlineDb.ts`
- `client/src/store/slices/remoteEventHandler.ts`
- `plugin-sdk/README.md`

Repository: https://github.com/liketrek/TREK
