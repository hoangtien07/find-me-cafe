import { idSchema, nonEmptyString } from '../common/primitives.schema';
import { placeHoursPeriodSchema } from '../maps/maps.schema';

import { z } from 'zod';

/**
 * Decision domain contract — the "chốt quán" (pick a venue) vertical slice.
 *
 * A DecisionSession is a 1:1 overlay on a technical TREK trip
 * (`decision_sessions.trip_id` UNIQUE): the trip stays the collaboration
 * container (places, trip room, permissions) while the decision domain keeps
 * its own state in its own tables. Spec: docs/decision/PRODUCT_SPEC.md.
 *
 * Wire conventions follow the rest of @trek/shared: snake_case field names
 * matching the DB columns, booleans as real booleans (the service converts
 * SQLite 0/1), and JSON columns cross the wire already parsed — `snapshot`,
 * `constraint_result`, `explanation`, `value`/`feedback` are the structured
 * counterparts of the *_json storage columns.
 */

// ── Enumerations ───────────────────────────────────────────────────────────

/**
 * Lifecycle of a decision room. Spec names them COLLECTING..CANCELED; the wire
 * uses lowercase like every other TREK status column (reservation_status,
 * import job status, ...). `ready` = enough inputs to resolve; `resolving` is
 * the in-flight window between the resolve request and the persisted run.
 */
export const DECISION_STATUSES = [
  'collecting',
  'ready',
  'resolving',
  'resolved',
  'selected',
  'closed',
  'canceled',
] as const;
export const decisionStatusSchema = z.enum(DECISION_STATUSES);
export type DecisionStatus = z.infer<typeof decisionStatusSchema>;

/**
 * Travel mode the group agrees to compare on. Closed set on purpose — the
 * resolver and the TravelMatrixProvider contract only handle these. `driving`
 * covers motorbike travel, the common urban-VN case.
 */
export const DECISION_TRAVEL_MODES = ['walking', 'driving', 'cycling', 'transit'] as const;
export const decisionTravelModeSchema = z.enum(DECISION_TRAVEL_MODES);
export type DecisionTravelMode = z.infer<typeof decisionTravelModeSchema>;

/** Strategy identifiers for the fairness engine (internal; never user-facing). */
export const DECISION_FAIRNESS_STRATEGIES = ['min_sum', 'min_max', 'min_variance', 'leximin', 'hybrid'] as const;
export const decisionFairnessStrategySchema = z.enum(DECISION_FAIRNESS_STRATEGIES);
export type DecisionFairnessStrategy = z.infer<typeof decisionFairnessStrategySchema>;

/** The resolver implementation version stamped onto every run. */
export const DECISION_RESOLVER_V1 = 'resolver-v1' as const;
/** MVP2 resolver (M2-06): V2 hard constraints + fairness metrics. */
export const DECISION_RESOLVER_V2 = 'resolver-v2' as const;

// ── Structured payloads (stored as *_json columns, parsed on the wire) ─────

/**
 * What a hard-constraint run decided about one candidate. UNKNOWN is a third
 * verdict, not a silent pass: a candidate whose travel time or opening hours we
 * cannot verify is reported in `unknowns`, never smuggled into `eligible`.
 */
export const decisionConstraintFindingSchema = z.object({
  type: nonEmptyString,
  detail: z.string().optional(),
  participant_id: idSchema.nullish(),
  /** V2: which candidate the finding concerns (one check family per row). */
  candidate_id: idSchema.nullish(),
  /** V2 verdict: 'fail' for violations, 'unknown' for unverifiable checks. */
  result: z.enum(['pass', 'fail', 'unknown']).optional(),
  /** V2 provenance: what evidence produced the finding. */
  source: z.string().optional(),
});
export type DecisionConstraintFinding = z.infer<typeof decisionConstraintFindingSchema>;

export const decisionConstraintResultSchema = z.object({
  eligible: z.boolean(),
  violations: z.array(decisionConstraintFindingSchema),
  unknowns: z.array(decisionConstraintFindingSchema),
});
export type DecisionConstraintResult = z.infer<typeof decisionConstraintResultSchema>;

/**
 * The structured Top-3 explanation — evidence and trade-offs, never a fake
 * percentage ("87.381% fit"). `travel_times` is per participant so the host can
 * show "An 16m · Bình 18m · Chi 17m".
 */
export const decisionExplanationTravelSchema = z.object({
  participant_id: idSchema,
  display_name: z.string(),
  duration_seconds: z.number().nullable(),
  status: z.string(),
  /** The participant's effective mode (their own, else the session default). */
  travel_mode: decisionTravelModeSchema.nullable(),
});
export type DecisionExplanationTravel = z.infer<typeof decisionExplanationTravelSchema>;

export const decisionExplanationSchema = z.object({
  headline: z.string(),
  strengths: z.array(z.string()),
  tradeoffs: z.array(z.string()),
  travel_times: z.array(decisionExplanationTravelSchema),
});
export type DecisionExplanation = z.infer<typeof decisionExplanationSchema>;

/**
 * The evidence snapshot taken when a TREK Place becomes a decision candidate.
 * TREK places are trip-scoped rows, so the same venue in another trip is a
 * different row — the snapshot pins name/coords/provider ids/price at candidate
 * time so a recommendation run stays reproducible after the place is edited.
 */
/**
 * Place facts the details endpoint reads off provider data (OSM tags today).
 * Bounded rather than a record: this is the raw material the venue-context
 * pass (M2-08) scores, so the vocabulary is fixed here.
 */
export const decisionCandidateFactsSchema = z.object({
  cuisine: z.string().nullable().optional(),
  menu_url: z.string().nullable().optional(),
  outdoor_seating: z.string().nullable().optional(),
  takeaway: z.string().nullable().optional(),
  delivery: z.string().nullable().optional(),
  wheelchair: z.string().nullable().optional(),
  vegetarian: z.string().nullable().optional(),
  vegan: z.string().nullable().optional(),
  internet_access: z.string().nullable().optional(),
});
export type DecisionCandidateFacts = z.infer<typeof decisionCandidateFactsSchema>;

export const decisionCandidateSnapshotSchema = z.object({
  name: z.string(),
  lat: z.number().nullable().optional(),
  lng: z.number().nullable().optional(),
  address: z.string().nullable().optional(),
  google_place_id: z.string().nullable().optional(),
  google_ftid: z.string().nullable().optional(),
  amap_poi_id: z.string().nullable().optional(),
  osm_id: z.string().nullable().optional(),
  price: z.number().nullable().optional(),
  currency: z.string().nullable().optional(),
  rating: z.number().nullable().optional(),
  rating_count: z.number().int().nullable().optional(),
  /** Opening-hours evidence: localised display lines plus machine-readable
   * periods (the same shape the maps details endpoint returns), so the
   * CLOSED_AT_DECISION_TIME constraint can evaluate rather than display. */
  opening_weekdays: z.array(z.string()).nullable().optional(),
  opening_periods: z.array(placeHoursPeriodSchema).nullable().optional(),
  opening_special_days: z.array(z.string()).nullable().optional(),
  open_now: z.boolean().nullable().optional(),
  facts: decisionCandidateFactsSchema.nullable().optional(),
  website: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  google_maps_url: z.string().nullable().optional(),
  /** Which provider answered the details lookup ('trek-places',
   * 'openstreetmap', 'google', 'amap'; 'quick-add' when typed by hand). */
  source: z.string().nullable().optional(),
  /** ISO time the evidence was fetched — staleness provenance for the run. */
  retrieved_at: z.string().nullable().optional(),
  /** The TREK category name at snapshot time — what veto_category checks. */
  category: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  image_url: z.string().nullable().optional(),
});
export type DecisionCandidateSnapshot = z.infer<typeof decisionCandidateSnapshotSchema>;

/**
 * Provider evidence the host just fetched from /api/maps/details — carried on
 * the add-candidate body so the snapshot records what the host saw, with
 * provenance, without a second provider round trip server-side. The place row
 * already carries name/coords/ids/website/phone/image_url; this covers the
 * parts a Place has no column for.
 */
export const decisionCandidateEvidenceSchema = z.object({
  source: z.string(),
  retrieved_at: z.string(),
  rating: z.number().nullable().optional(),
  rating_count: z.number().int().nullable().optional(),
  open_now: z.boolean().nullable().optional(),
  opening_weekdays: z.array(z.string()).nullable().optional(),
  opening_periods: z.array(placeHoursPeriodSchema).nullable().optional(),
  opening_special_days: z.array(z.string()).nullable().optional(),
  facts: decisionCandidateFactsSchema.nullable().optional(),
  google_maps_url: z.string().nullable().optional(),
});
export type DecisionCandidateEvidence = z.infer<typeof decisionCandidateEvidenceSchema>;

// ── Entities (wire rows) ───────────────────────────────────────────────────

/**
 * The session row plus `title`, joined from the backing technical trip
 * (decision_sessions deliberately holds no title of its own).
 */
export const decisionSessionSchema = z.object({
  id: idSchema,
  trip_id: idSchema,
  status: decisionStatusSchema,
  occasion: z.string().nullable(),
  scheduled_at: z.string().nullable(),
  travel_mode: decisionTravelModeSchema,
  currency: z.string(),
  created_by_user_id: idSchema,
  created_at: z.string(),
  updated_at: z.string(),
  /** Joined from trips.title — the decision table intentionally has none. */
  title: z.string().optional(),
});
export type DecisionSession = z.infer<typeof decisionSessionSchema>;

/**
 * A decision invite as the wire ever sees it — `token_hash` never leaves the
 * server. The plaintext token exists exactly once, in `decisionInviteTokenSchema`
 * on the create response.
 */
export const decisionInviteSchema = z.object({
  id: idSchema,
  decision_session_id: idSchema,
  expires_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  created_by_user_id: idSchema,
  created_at: z.string(),
});
export type DecisionInvite = z.infer<typeof decisionInviteSchema>;

/** Create response: the only payload that ever carries the plaintext token. */
export const decisionInviteTokenSchema = decisionInviteSchema.extend({
  token: z.string(),
});
export type DecisionInviteWithToken = z.infer<typeof decisionInviteTokenSchema>;

/**
 * Public invite preview (GET /api/decision-invites/:token) — the minimum a
 * stranger needs to decide whether to join. Participant display names and
 * contexts are deliberately absent: previewing an invite reveals the outing,
 * not who is in it.
 */
export const decisionInvitePreviewSchema = z.object({
  title: z.string(),
  occasion: z.string().nullable(),
  scheduled_at: z.string().nullable(),
  status: decisionStatusSchema,
  participant_count: z.number().int(),
  expires_at: z.string().nullable(),
});
export type DecisionInvitePreview = z.infer<typeof decisionInvitePreviewSchema>;

/** An anonymous participant. There is no user_id link by design. */
export const decisionParticipantSchema = z.object({
  id: idSchema,
  decision_session_id: idSchema,
  display_name: z.string(),
  origin_lat: z.number().nullable(),
  origin_lng: z.number().nullable(),
  origin_label: z.string().nullable(),
  max_travel_minutes: z.number().int().nullable(),
  budget_min: z.number().nullable(),
  budget_max: z.number().nullable(),
  /** null = ride the session's default mode. */
  travel_mode: decisionTravelModeSchema.nullable(),
  submitted_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type DecisionParticipant = z.infer<typeof decisionParticipantSchema>;

/** The join response — carries the scoped participant token exactly once. */
export const decisionJoinResponseSchema = z.object({
  participant: decisionParticipantSchema,
  participant_token: z.string(),
});
export type DecisionJoinResponse = z.infer<typeof decisionJoinResponseSchema>;

/** One preference row (a participant's ranked want, or a must-have when hard). */
export const decisionPreferenceSchema = z.object({
  id: idSchema,
  participant_id: idSchema,
  key: z.string(),
  value: z.string(),
  weight: z.number(),
  is_hard: z.boolean(),
});
export type DecisionPreference = z.infer<typeof decisionPreferenceSchema>;

/**
 * A hard constraint row. `participant_id` is null for session-level rules the
 * host set and set for participant deal-breakers. `value` is the parsed form of
 * the value_json column.
 */
export const decisionConstraintSchema = z.object({
  id: idSchema,
  decision_session_id: idSchema,
  participant_id: idSchema.nullable(),
  type: z.string(),
  operator: z.string(),
  value: z.unknown(),
  is_hard: z.boolean(),
});
export type DecisionConstraint = z.infer<typeof decisionConstraintSchema>;

/** Everything a participant has submitted — the session context on the wire. */
export const decisionParticipantContextSchema = z.object({
  participant: decisionParticipantSchema,
  preferences: z.array(decisionPreferenceSchema),
  deal_breakers: z.array(decisionConstraintSchema),
});
export type DecisionParticipantContext = z.infer<typeof decisionParticipantContextSchema>;

/**
 * A roster entry — who else is in the room, projected down to what a stranger
 * may see. The origin/travel-mode fields are optional on purpose: the
 * participant view's roster leaves them off entirely, while the host GET and
 * the participant WS payloads carry them so the comparison map (M2-09) can
 * draw the group's geometry. They stay off budgets/preferences either way.
 */
export const decisionParticipantRosterEntrySchema = z.object({
  id: idSchema,
  display_name: z.string(),
  submitted_at: z.string().nullable(),
  origin_lat: z.number().nullable().optional(),
  origin_lng: z.number().nullable().optional(),
  origin_label: z.string().nullable().optional(),
  /** null = riding the session default; absent on the participant roster. */
  travel_mode: decisionTravelModeSchema.nullable().optional(),
});
export type DecisionParticipantRosterEntry = z.infer<typeof decisionParticipantRosterEntrySchema>;

/** GET /api/decision-participant/session — the room, the roster, and one's own context. */
export const decisionParticipantSessionResponseSchema = z.object({
  participant: decisionParticipantSchema,
  decision: decisionSessionSchema,
  participants: z.array(decisionParticipantRosterEntrySchema),
  preferences: z.array(decisionPreferenceSchema),
  deal_breakers: z.array(decisionConstraintSchema),
});
export type DecisionParticipantSessionResponse = z.infer<typeof decisionParticipantSessionResponseSchema>;

/**
 * A candidate venue pinned to this session. `place_id` references the
 * trip-scoped TREK Place; `snapshot` preserves the evidence the resolver read.
 */
export const decisionCandidateSchema = z.object({
  id: idSchema,
  decision_session_id: idSchema,
  place_id: idSchema,
  source: z.string(),
  added_by_type: z.enum(['host', 'participant', 'system']),
  added_by_id: idSchema.nullable(),
  snapshot: decisionCandidateSnapshotSchema.nullable(),
  created_at: z.string(),
});
export type DecisionCandidate = z.infer<typeof decisionCandidateSchema>;

/** One participant × candidate cell of the travel matrix. */
export const decisionTravelEstimateSchema = z.object({
  id: idSchema,
  decision_session_id: idSchema,
  participant_id: idSchema,
  candidate_id: idSchema,
  travel_mode: decisionTravelModeSchema,
  distance_meters: z.number().nullable(),
  duration_seconds: z.number().nullable(),
  /** 'ok' or the explicit partial-failure cell code (never silently absent). */
  status: z.string(),
  provider: z.string(),
  computed_at: z.string(),
});
export type DecisionTravelEstimate = z.infer<typeof decisionTravelEstimateSchema>;

/** A versioned resolver run — historical runs are never overwritten. */
export const recommendationRunSchema = z.object({
  id: idSchema,
  decision_session_id: idSchema,
  strategy_version: z.string(),
  status: z.string(),
  input_hash: z.string().nullable(),
  created_at: z.string(),
  completed_at: z.string().nullable(),
});
export type RecommendationRun = z.infer<typeof recommendationRunSchema>;

/**
 * One scored candidate inside a run (the `recommendation_scores` row). The plan
 * calls this entity RecommendationCandidate; the table name wins on the wire.
 * `rank` is null for ineligible candidates.
 */
export const recommendationScoreSchema = z.object({
  id: idSchema,
  recommendation_run_id: idSchema,
  candidate_id: idSchema,
  eligible: z.boolean(),
  constraint_result: decisionConstraintResultSchema.nullable(),
  place_fit: z.number(),
  group_fit: z.number(),
  travel_fairness: z.number(),
  context_fit: z.number(),
  trust_score: z.number(),
  total_score: z.number(),
  rank: z.number().int().nullable(),
  explanation: decisionExplanationSchema.nullable(),
});
export type RecommendationScore = z.infer<typeof recommendationScoreSchema>;

/** The score row with its candidate embedded — the Top-3 result view item. */
export const recommendationResultItemSchema = recommendationScoreSchema.extend({
  candidate: decisionCandidateSchema,
});
export type RecommendationResultItem = z.infer<typeof recommendationResultItemSchema>;

/** GET /api/decisions/:id/recommendations/latest response. */
export const recommendationResultSchema = z.object({
  run: recommendationRunSchema,
  items: z.array(recommendationResultItemSchema),
});
export type RecommendationResult = z.infer<typeof recommendationResultSchema>;

/** The host's recorded choice. `recommendation_run_id` null = picked off-list. */
export const decisionSelectionSchema = z.object({
  id: idSchema,
  decision_session_id: idSchema,
  candidate_id: idSchema,
  recommendation_run_id: idSchema.nullable(),
  selected_by_user_id: idSchema.nullable(),
  selected_at: z.string(),
});
export type DecisionSelection = z.infer<typeof decisionSelectionSchema>;

/** Post-outcome feedback — the DecisionGraph learnable record's tail. */
export const decisionFeedbackSchema = z.object({
  id: idSchema,
  decision_session_id: idSchema,
  participant_id: idSchema.nullable(),
  candidate_id: idSchema,
  fit_score: z.number().int().min(1).max(5),
  would_choose_again: z.boolean(),
  regret_reason: z.string().nullable(),
  feedback: z.record(z.string(), z.unknown()).nullable(),
  created_at: z.string(),
});
export type DecisionFeedback = z.infer<typeof decisionFeedbackSchema>;

/** GET /api/decisions/:id response — the room, its roster, and any locked-in selection. */
export const decisionGetResponseSchema = z.object({
  decision: decisionSessionSchema,
  participants: z.array(decisionParticipantRosterEntrySchema),
  /** The host's locked-in venue choice; null until the room reaches 'selected'. */
  selection: decisionSelectionSchema.nullable(),
});
export type DecisionGetResponse = z.infer<typeof decisionGetResponseSchema>;

// ── Request bodies ─────────────────────────────────────────────────────────

export const createDecisionRequestSchema = z.object({
  title: nonEmptyString.max(200),
  occasion: z.string().trim().max(50).nullish(),
  scheduled_at: z.string().nullish(),
  travel_mode: decisionTravelModeSchema.optional(),
  currency: z.string().trim().max(10).optional(),
});
export type CreateDecisionRequest = z.infer<typeof createDecisionRequestSchema>;

/**
 * Partial update. `status` transitions are validated by the service — only the
 * lifecycle moves a session can actually make are accepted (never a client-set
 * 'resolved'; that state is earned by POST /resolve).
 */
export const updateDecisionRequestSchema = z.object({
  title: nonEmptyString.max(200).optional(),
  occasion: z.string().trim().max(50).nullish(),
  scheduled_at: z.string().nullish(),
  travel_mode: decisionTravelModeSchema.optional(),
  status: decisionStatusSchema.optional(),
});
export type UpdateDecisionRequest = z.infer<typeof updateDecisionRequestSchema>;

/**
 * Same contract shape as the trip invite link (trip-invite.schema.ts) but
 * digits only — the new route has no form-input string legacy to mirror.
 */
export const createDecisionInviteRequestSchema = z.object({
  expires_in_days: z.number().int().positive().nullish(),
});
export type CreateDecisionInviteRequest = z.infer<typeof createDecisionInviteRequestSchema>;

/** A top-preference or must-have entry inside the participant context body. */
export const decisionPreferenceInputSchema = z.object({
  key: z.string().trim().min(1).max(50),
  value: z.string().trim().min(1).max(100),
  weight: z.number().min(0).max(1).optional(),
  is_hard: z.boolean().optional(),
});
export type DecisionPreferenceInput = z.infer<typeof decisionPreferenceInputSchema>;

/** A participant deal-breaker — always persisted as a hard constraint. */
export const decisionDealBreakerInputSchema = z.object({
  type: z.string().trim().min(1).max(50),
  operator: z.string().trim().max(20).optional(),
  value: z.unknown().optional(),
});
export type DecisionDealBreakerInput = z.infer<typeof decisionDealBreakerInputSchema>;

/**
 * PUT /api/decision-participant/context — the whole context in one write
 * (the <45s participant flow submits once). Nullable scalar fields accept null
 * to clear; `preferences`/`deal_breakers` replace the stored set when present.
 * Spec caps top preferences at 3.
 */
export const updateParticipantContextRequestSchema = z
  .object({
    origin: z
      .object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        label: z.string().trim().max(200).optional(),
      })
      .nullish(),
    max_travel_minutes: z.number().int().min(1).max(600).nullish(),
    budget_min: z.number().min(0).nullish(),
    budget_max: z.number().min(0).nullish(),
    /** Per-participant ride mode; absent/null keeps the session default. */
    travel_mode: decisionTravelModeSchema.nullish(),
    preferences: z.array(decisionPreferenceInputSchema).max(3).optional(),
    deal_breakers: z.array(decisionDealBreakerInputSchema).optional(),
  })
  .refine((v) => v.budget_min == null || v.budget_max == null || v.budget_min <= v.budget_max, {
    message: 'budget_min must not exceed budget_max',
  });
export type UpdateParticipantContextRequest = z.infer<typeof updateParticipantContextRequestSchema>;

/**
 * Anonymous join — display name plus an optional inline context so the fast
 * path really is name → one form → done.
 */
export const joinDecisionRequestSchema = z.object({
  display_name: z.string().trim().min(1).max(50),
  context: updateParticipantContextRequestSchema.optional(),
});
export type JoinDecisionRequest = z.infer<typeof joinDecisionRequestSchema>;

export const addDecisionCandidateRequestSchema = z.object({
  place_id: idSchema,
  evidence: decisionCandidateEvidenceSchema.optional(),
});
export type AddDecisionCandidateRequest = z.infer<typeof addDecisionCandidateRequestSchema>;

/**
 * No body inputs: the resolver reads current participants + candidates. Retries
 * ride on the X-Idempotency-Key header, not body fields.
 */
export const resolveDecisionRequestSchema = z.object({});
export type ResolveDecisionRequest = z.infer<typeof resolveDecisionRequestSchema>;

export const selectDecisionRequestSchema = z.object({
  candidate_id: idSchema,
});
export type SelectDecisionRequest = z.infer<typeof selectDecisionRequestSchema>;

/** V1 feedback is three questions, not a survey. */
export const createDecisionFeedbackRequestSchema = z.object({
  candidate_id: idSchema,
  fit_score: z.number().int().min(1).max(5),
  would_choose_again: z.boolean(),
  regret_reason: z.string().trim().max(500).nullish(),
});
export type CreateDecisionFeedbackRequest = z.infer<typeof createDecisionFeedbackRequestSchema>;

/**
 * Decision telemetry (spec §25 + plan Phase 15) — the DecisionGraph funnel.
 * Server-visible events are recorded by the services; participants can only
 * self-report the two client-side actions in PARTICIPANT_TRACKABLE_EVENTS.
 */
export const DECISION_EVENT_TYPES = [
  'decision_created',
  'invite_created',
  'participant_joined',
  'participant_context_submitted',
  'candidate_added',
  'resolve_started',
  'resolve_completed',
  'resolve_failed',
  'recommendation_viewed',
  'venue_selected',
  'navigation_opened',
  'feedback_submitted',
] as const;
export const decisionEventTypeSchema = z.enum(DECISION_EVENT_TYPES);
export type DecisionEventType = z.infer<typeof decisionEventTypeSchema>;

export const decisionEventSchema = z.object({
  id: idSchema,
  decision_session_id: idSchema,
  type: decisionEventTypeSchema,
  user_id: idSchema.nullable(),
  participant_id: idSchema.nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  created_at: z.string(),
});
export type DecisionEvent = z.infer<typeof decisionEventSchema>;

/** The only two funnel steps that happen on a participant's device. */
export const PARTICIPANT_TRACKABLE_EVENTS = ['navigation_opened', 'recommendation_viewed'] as const;
export const trackDecisionEventRequestSchema = z.object({
  event: z.enum(PARTICIPANT_TRACKABLE_EVENTS),
});
export type TrackDecisionEventRequest = z.infer<typeof trackDecisionEventRequestSchema>;
