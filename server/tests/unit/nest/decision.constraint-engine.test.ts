import { describe, expect, it } from 'vitest';
import { evaluateConstraints, isOpenAt } from '../../../src/nest/decision/resolver/constraint-engine';
import type { DecisionCandidate, DecisionSession, DecisionTravelEstimate } from '@trek/shared';
import type { ParticipantContext } from '../../../src/nest/decision/resolver/resolver.types';

/**
 * CLOSED_AT_DECISION_TIME (M2-07): a scheduled session reads the candidate's
 * opening periods; missing evidence is UNKNOWN, never a silent pass.
 */
describe('isOpenAt', () => {
  const weekdays = [
    // Mon–Fri 07:00–22:00 (days 1–5)
    ...[1, 2, 3, 4, 5].map((day) => ({
      open: { day, hour: 7, minute: 0 },
      close: { day, hour: 22, minute: 0 },
    })),
  ];

  it('matches inside a same-day period and misses outside it', () => {
    // A Monday at 12:00 vs 23:00.
    expect(isOpenAt(weekdays, new Date('2026-09-28T12:00:00'))).toBe(true);
    expect(isOpenAt(weekdays, new Date('2026-09-28T23:00:00'))).toBe(false);
  });

  it('misses on a day with no period (weekend closed)', () => {
    // Sunday 2026-10-04 — no period covers it.
    expect(isOpenAt(weekdays, new Date('2026-10-04T12:00:00'))).toBe(false);
  });

  it('straddles overnight periods', () => {
    // Bar open Sat 20:00 → Sun 02:00.
    const overnight = [
      { open: { day: 6, hour: 20, minute: 0 }, close: { day: 0, hour: 2, minute: 0 } },
    ];
    expect(isOpenAt(overnight, new Date('2026-10-03T23:30:00'))).toBe(true); // Saturday late
    expect(isOpenAt(overnight, new Date('2026-10-04T01:00:00'))).toBe(true); // past midnight
    expect(isOpenAt(overnight, new Date('2026-10-04T03:00:00'))).toBe(false); // after close
  });

  it('treats a null close as never-closing (24/7)', () => {
    const always = [{ open: { day: 0, hour: 0, minute: 0 }, close: null }];
    expect(isOpenAt(always, new Date('2026-10-04T03:00:00'))).toBe(true);
  });
});

describe('evaluateConstraints — scheduled session', () => {
  const session = { id: 1, trip_id: 1, scheduled_at: '2026-09-28T23:00:00' } as unknown as DecisionSession;
  const candidateWith = (snapshot: Partial<NonNullable<DecisionCandidate['snapshot']>> | null): DecisionCandidate =>
    ({ id: 1, place_id: 1, snapshot } as unknown as DecisionCandidate);

  it('flags closed_at_time when periods say the venue is shut', () => {
    const c = candidateWith({
      name: 'X',
      opening_periods: [{ open: { day: 1, hour: 7, minute: 0 }, close: { day: 1, hour: 22, minute: 0 } }],
    });
    const r = evaluateConstraints({ candidate: c, session, participants: [], estimateByParticipant: new Map() });
    expect(r.violations.map((v) => v.type)).toContain('closed_at_decision_time');
    expect(r.eligible).toBe(false);
  });

  it('passes (no violation) when periods cover the scheduled time', () => {
    const c = candidateWith({
      name: 'X',
      opening_periods: [{ open: { day: 1, hour: 7, minute: 0 }, close: { day: 1, hour: 23, minute: 59 } }],
    });
    const r = evaluateConstraints({ candidate: c, session, participants: [], estimateByParticipant: new Map() });
    expect(r.violations).toHaveLength(0);
    expect(r.unknowns).toHaveLength(0);
  });

  it('UNKNOWNs a special-day override and missing periods alike', () => {
    const special = candidateWith({
      name: 'X',
      opening_periods: [{ open: { day: 1, hour: 7, minute: 0 }, close: { day: 1, hour: 22, minute: 0 } }],
      opening_special_days: ['2026-09-28'],
    });
    const none = candidateWith({ name: 'X' });
    for (const c of [special, none]) {
      const r = evaluateConstraints({ candidate: c, session, participants: [], estimateByParticipant: new Map() });
      expect(r.violations).toHaveLength(0);
      expect(r.unknowns.map((u) => u.type)).toContain('closed_at_decision_time');
    }
  });

  it('skips the check entirely when the session is unscheduled', () => {
    const unscheduled = { ...session, scheduled_at: null } as unknown as DecisionSession;
    const c = candidateWith({ name: 'X' });
    const r = evaluateConstraints({ candidate: c, session: unscheduled, participants: [], estimateByParticipant: new Map() });
    expect(r.unknowns).toHaveLength(0);
  });
});

/**
 * V2 families (M2-06): NO_ROUTE, MANDATORY_ATTRIBUTE_MISSING, and the finding
 * shape itself — candidate_id / result / source on every row.
 */
describe('evaluateConstraints — V2 families', () => {
  const session = { id: 1, trip_id: 1, scheduled_at: null } as unknown as DecisionSession;
  const candidateWith = (snapshot: Partial<NonNullable<DecisionCandidate['snapshot']>> | null): DecisionCandidate =>
    ({ id: 7, place_id: 1, snapshot } as unknown as DecisionCandidate);
  const participant = (over: Record<string, unknown> = {}) =>
    ({ id: 9, display_name: 'An', max_travel_minutes: null, budget_max: null, ...over }) as unknown as ParticipantContext['participant'];
  const est = (status: string, duration = 600): DecisionTravelEstimate =>
    ({ status, duration_seconds: duration, travel_mode: 'driving' }) as unknown as DecisionTravelEstimate;
  const ctx = (p: ParticipantContext['participant'], preferences: ParticipantContext['preferences'] = [], dealBreakers: ParticipantContext['dealBreakers'] = []): ParticipantContext =>
    ({ participant: p, preferences, dealBreakers });

  it('a no_route cell fails hard even without a travel cap', () => {
    const p = participant();
    const r = evaluateConstraints({
      candidate: candidateWith({ name: 'X' }),
      session,
      participants: [ctx(p)],
      estimateByParticipant: new Map([[9, est('no_route')]]),
    });
    expect(r.violations[0]).toMatchObject({ type: 'no_route', participant_id: 9, candidate_id: 7, result: 'fail', source: 'matrix' });
    expect(r.eligible).toBe(false);
  });

  it('a missing/error cell is UNKNOWN no_route, not a violation', () => {
    const p = participant();
    for (const cell of [null, est('error', 0)]) {
      const r = evaluateConstraints({
        candidate: candidateWith({ name: 'X' }),
        session,
        participants: [ctx(p)],
        estimateByParticipant: new Map([[9, cell]]),
      });
      expect(r.violations).toHaveLength(0);
      expect(r.unknowns[0]).toMatchObject({ type: 'no_route', result: 'unknown', source: 'matrix' });
    }
  });

  it('a hard must-have the venue provably lacks fails; unverifiable stays UNKNOWN', () => {
    const p = participant();
    const mustWifi = [{ is_hard: true, key: 'wifi', value: 'wifi', weight: 1 }] as unknown as ParticipantContext['preferences'];
    const lacking = evaluateConstraints({
      candidate: candidateWith({ name: 'X', facts: { internet_access: 'no' } }),
      session,
      participants: [ctx(p, mustWifi)],
      estimateByParticipant: new Map([[9, est('ok')]]),
    });
    expect(lacking.violations[0]).toMatchObject({ type: 'mandatory_attribute_missing', result: 'fail' });
    const unverifiable = evaluateConstraints({
      candidate: candidateWith({ name: 'X', facts: {} }),
      session,
      participants: [ctx(p, mustWifi)],
      estimateByParticipant: new Map([[9, est('ok')]]),
    });
    expect(unverifiable.violations).toHaveLength(0);
    expect(unverifiable.unknowns[0]?.type).toBe('mandatory_attribute_missing');
    const satisfied = evaluateConstraints({
      candidate: candidateWith({ name: 'X', facts: { internet_access: 'wlan' } }),
      session,
      participants: [ctx(p, mustWifi)],
      estimateByParticipant: new Map([[9, est('ok')]]),
    });
    expect(satisfied.eligible).toBe(true);
    expect(satisfied.unknowns).toHaveLength(0);
  });
});
