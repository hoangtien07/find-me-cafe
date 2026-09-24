import { DECISION_WS_EVENT_NAMES, decisionWsEventPayloads } from './decision-events.schema';
import {
  createDecisionRequestSchema,
  createDecisionInviteRequestSchema,
  createDecisionFeedbackRequestSchema,
  addDecisionCandidateRequestSchema,
  joinDecisionRequestSchema,
  updateDecisionRequestSchema,
  updateParticipantContextRequestSchema,
  selectDecisionRequestSchema,
  resolveDecisionRequestSchema,
  decisionSessionSchema,
  decisionParticipantSchema,
  decisionConstraintResultSchema,
  decisionExplanationSchema,
  recommendationResultSchema,
  decisionInvitePreviewSchema,
  decisionJoinResponseSchema,
  DECISION_STATUSES,
  DECISION_RESOLVER_V1,
} from './decision.schema';

import { describe, it, expect } from 'vitest';

describe('decision contract', () => {
  describe('entities', () => {
    it('parses a session row with the trip-joined title', () => {
      const row = {
        id: 2,
        trip_id: 11,
        status: 'collecting',
        occasion: 'hangout',
        scheduled_at: '2026-09-24 20:00:00',
        travel_mode: 'driving',
        currency: 'VND',
        created_by_user_id: 1,
        created_at: '2026-09-24 08:00:00',
        updated_at: '2026-09-24 08:00:00',
        title: 'Tối nay đi đâu?',
      };
      expect(decisionSessionSchema.safeParse(row).success).toBe(true);
    });

    it('rejects an unknown session status', () => {
      const row = {
        id: 2,
        trip_id: 11,
        status: 'vibes',
        occasion: null,
        scheduled_at: null,
        travel_mode: 'driving',
        currency: 'VND',
        created_by_user_id: 1,
        created_at: 'x',
        updated_at: 'x',
      };
      expect(decisionSessionSchema.safeParse(row).success).toBe(false);
    });

    it('participant rows allow unsubmitted contexts (all nullable)', () => {
      const row = {
        id: 1,
        decision_session_id: 2,
        display_name: 'An',
        origin_lat: null,
        origin_lng: null,
        origin_label: null,
        max_travel_minutes: null,
        budget_min: null,
        budget_max: null,
        submitted_at: null,
        created_at: 'x',
        updated_at: 'x',
      };
      expect(decisionParticipantSchema.safeParse(row).success).toBe(true);
    });

    it('a constraint result keeps UNKNOWN distinct from PASS', () => {
      const pass = { eligible: true, violations: [], unknowns: [] };
      const unknown = { eligible: false, violations: [], unknowns: [{ code: 'missing_origin' }] };
      const violation = {
        eligible: false,
        violations: [{ code: 'travel_over_hard_max', participant_id: 3 }],
        unknowns: [],
      };
      expect(decisionConstraintResultSchema.safeParse(pass).success).toBe(true);
      expect(decisionConstraintResultSchema.safeParse(unknown).success).toBe(true);
      expect(decisionConstraintResultSchema.safeParse(violation).success).toBe(true);
    });

    it('an explanation carries evidence and trade-offs, never a percentage', () => {
      const exp = {
        headline: 'Cân bằng nhất cho nhóm',
        strengths: ['tất cả trong giới hạn di chuyển'],
        tradeoffs: ['đồ uống ít nổi bật hơn lựa chọn #2'],
        travel_times: [
          { participant_id: 1, display_name: 'An', duration_seconds: 960, status: 'ok' },
          { participant_id: 2, display_name: 'Bình', duration_seconds: null, status: 'missing_origin' },
        ],
      };
      expect(decisionExplanationSchema.safeParse(exp).success).toBe(true);
    });

    it('the latest-recommendation response embeds candidates in scored items', () => {
      const result = {
        run: {
          id: 7,
          decision_session_id: 2,
          strategy_version: DECISION_RESOLVER_V1,
          status: 'completed',
          input_hash: 'abc',
          created_at: 'x',
          completed_at: 'x',
        },
        items: [
          {
            id: 1,
            recommendation_run_id: 7,
            candidate_id: 5,
            eligible: true,
            constraint_result: { eligible: true, violations: [], unknowns: [] },
            place_fit: 0.8,
            group_fit: 0.7,
            travel_fairness: 0.9,
            context_fit: 0.6,
            trust_score: 0.5,
            total_score: 0.75,
            rank: 1,
            explanation: { headline: 'h', strengths: [], tradeoffs: [], travel_times: [] },
            candidate: {
              id: 5,
              decision_session_id: 2,
              place_id: 9,
              source: 'search',
              added_by_type: 'host',
              added_by_id: 1,
              snapshot: { name: 'Cafe A', lat: 10.77, lng: 106.7 },
              created_at: 'x',
            },
          },
        ],
      };
      expect(recommendationResultSchema.safeParse(result).success).toBe(true);
    });

    it('invite preview is minimal — no participant PII surface', () => {
      const preview = {
        title: 'Tối nay đi đâu?',
        occasion: 'hangout',
        scheduled_at: null,
        status: 'collecting',
        participant_count: 2,
        expires_at: null,
      };
      const parsed = decisionInvitePreviewSchema.parse(preview);
      expect('participants' in parsed).toBe(false);
      expect('token' in parsed).toBe(false);
    });

    it('the join response is the only payload carrying a participant token', () => {
      const join = {
        participant: {
          id: 1,
          decision_session_id: 2,
          display_name: 'An',
          origin_lat: null,
          origin_lng: null,
          origin_label: null,
          max_travel_minutes: null,
          budget_min: null,
          budget_max: null,
          submitted_at: null,
          created_at: 'x',
          updated_at: 'x',
        },
        participant_token: 'opaque',
      };
      expect(decisionJoinResponseSchema.safeParse(join).success).toBe(true);
    });
  });

  describe('requests', () => {
    it('create takes title + optional occasion/scheduled_at', () => {
      expect(createDecisionRequestSchema.safeParse({ title: 'Tối nay đi đâu?' }).success).toBe(true);
      expect(
        createDecisionRequestSchema.safeParse({ title: 'x', occasion: 'hangout', scheduled_at: '2026-09-24T20:00:00Z' })
          .success,
      ).toBe(true);
      expect(createDecisionRequestSchema.safeParse({}).success).toBe(false);
      expect(createDecisionRequestSchema.safeParse({ title: '   ' }).success).toBe(false);
    });

    it('update is partial and may carry a status the service then validates', () => {
      expect(updateDecisionRequestSchema.safeParse({}).success).toBe(true);
      expect(updateDecisionRequestSchema.safeParse({ status: 'closed' }).success).toBe(true);
      expect(updateDecisionRequestSchema.safeParse({ status: 'bogus' }).success).toBe(false);
      // The enum accepts every lifecycle label; the SERVICE owns which transitions are legal.
      for (const s of DECISION_STATUSES) {
        expect(updateDecisionRequestSchema.safeParse({ status: s }).success).toBe(true);
      }
    });

    it('invite creation accepts an optional positive day count only', () => {
      expect(createDecisionInviteRequestSchema.safeParse({}).success).toBe(true);
      expect(createDecisionInviteRequestSchema.safeParse({ expires_in_days: 7 }).success).toBe(true);
      expect(createDecisionInviteRequestSchema.safeParse({ expires_in_days: null }).success).toBe(true);
      expect(createDecisionInviteRequestSchema.safeParse({ expires_in_days: 0 }).success).toBe(false);
      expect(createDecisionInviteRequestSchema.safeParse({ expires_in_days: -1 }).success).toBe(false);
      expect(createDecisionInviteRequestSchema.safeParse({ expires_in_days: '7' }).success).toBe(false);
    });

    it('join requires a display name; context may ride along', () => {
      expect(joinDecisionRequestSchema.safeParse({ display_name: 'An' }).success).toBe(true);
      expect(joinDecisionRequestSchema.safeParse({}).success).toBe(false);
      expect(joinDecisionRequestSchema.safeParse({ display_name: '' }).success).toBe(false);
      expect(
        joinDecisionRequestSchema.safeParse({
          display_name: 'An',
          context: { max_travel_minutes: 30, budget_max: 100000 },
        }).success,
      ).toBe(true);
    });

    it('participant context: accepts a full submission', () => {
      const body = {
        origin: { lat: 10.7769, lng: 106.7009, label: 'Quận 1' },
        max_travel_minutes: 30,
        budget_min: 30000,
        budget_max: 100000,
        preferences: [
          { key: 'drink', value: 'coffee', weight: 1 },
          { key: 'vibe', value: 'quiet', weight: 0.5 },
        ],
        deal_breakers: [{ type: 'veto_category', value: { category: 'bar' } }],
      };
      expect(updateParticipantContextRequestSchema.safeParse(body).success).toBe(true);
    });

    it('participant context: rejects inverted budgets and out-of-range coords', () => {
      expect(updateParticipantContextRequestSchema.safeParse({ budget_min: 100, budget_max: 50 }).success).toBe(false);
      expect(updateParticipantContextRequestSchema.safeParse({ origin: { lat: 91, lng: 0 } }).success).toBe(false);
      expect(updateParticipantContextRequestSchema.safeParse({ origin: { lat: 10, lng: 181 } }).success).toBe(false);
    });

    it('participant context: top preferences cap at 3 (spec)', () => {
      const prefs = [1, 2, 3, 4].map((i) => ({ key: 'k', value: `v${i}` }));
      expect(updateParticipantContextRequestSchema.safeParse({ preferences: prefs }).success).toBe(false);
      expect(updateParticipantContextRequestSchema.safeParse({ preferences: prefs.slice(0, 3) }).success).toBe(true);
    });

    it('candidate add takes a positive integer place id', () => {
      expect(addDecisionCandidateRequestSchema.safeParse({ place_id: 9 }).success).toBe(true);
      expect(addDecisionCandidateRequestSchema.safeParse({ place_id: -9 }).success).toBe(false);
      expect(addDecisionCandidateRequestSchema.safeParse({}).success).toBe(false);
    });

    it('resolve takes an empty body — inputs come from stored state', () => {
      expect(resolveDecisionRequestSchema.safeParse({}).success).toBe(true);
    });

    it('select takes a candidate id; feedback is the 3-question V1 form', () => {
      expect(selectDecisionRequestSchema.safeParse({ candidate_id: 5 }).success).toBe(true);
      expect(
        createDecisionFeedbackRequestSchema.safeParse({ candidate_id: 5, fit_score: 4, would_choose_again: true })
          .success,
      ).toBe(true);
      expect(
        createDecisionFeedbackRequestSchema.safeParse({ candidate_id: 5, fit_score: 6, would_choose_again: true })
          .success,
      ).toBe(false);
      expect(
        createDecisionFeedbackRequestSchema.safeParse({ candidate_id: 5, fit_score: 0, would_choose_again: true })
          .success,
      ).toBe(false);
      expect(createDecisionFeedbackRequestSchema.safeParse({ candidate_id: 5, fit_score: 3 }).success).toBe(false);
    });
  });

  describe('decision WS event payloads', () => {
    it('registers exactly the 7 planned events', () => {
      expect([...DECISION_WS_EVENT_NAMES].sort()).toEqual(
        [
          'decision:candidate-added',
          'decision:candidate-removed',
          'decision:participant-joined',
          'decision:participant-updated',
          'decision:recommendation-ready',
          'decision:selected',
          'decision:status-updated',
        ].sort(),
      );
    });

    it('payload schemas reject a structurally wrong event body', () => {
      const bad = decisionWsEventPayloads['decision:status-updated'].safeParse({
        decisionSessionId: 2,
        status: 'bogus',
      });
      expect(bad.success).toBe(false);
      const badJoin = decisionWsEventPayloads['decision:participant-joined'].safeParse({ participant: { id: 1 } });
      expect(badJoin.success).toBe(false);
    });
  });
});
