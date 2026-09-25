import { describe, expect, it } from 'vitest';
import { evaluateConstraints, isOpenAt } from '../../../src/nest/decision/resolver/constraint-engine';
import type { DecisionCandidate, DecisionSession } from '@trek/shared';

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
    expect(r.violations.map((v) => v.type)).toContain('closed_at_time');
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
      expect(r.unknowns.map((u) => u.type)).toContain('opening_hours');
    }
  });

  it('skips the check entirely when the session is unscheduled', () => {
    const unscheduled = { ...session, scheduled_at: null } as unknown as DecisionSession;
    const c = candidateWith({ name: 'X' });
    const r = evaluateConstraints({ candidate: c, session: unscheduled, participants: [], estimateByParticipant: new Map() });
    expect(r.unknowns).toHaveLength(0);
  });
});
