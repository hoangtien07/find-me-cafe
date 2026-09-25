import { describe, expect, it } from 'vitest';
import { computeFairness } from '../../../src/nest/decision/resolver/fairness-engine';
import type { DecisionTravelEstimate } from '@trek/shared';
import type { ParticipantContext } from '../../../src/nest/decision/resolver/resolver.types';

/**
 * Fairness V2 (M2-06, plan §16): the metric bundle the engine must compute —
 * mean/max/min/range/variance/p50 + hard-limit violations — and the HYBRID
 * principle that a small mean improvement must not justify one member
 * travelling dramatically farther.
 */
const p = (id: number, cap: number | null = null): ParticipantContext => ({
  participant: { id, display_name: `P${id}`, max_travel_minutes: cap, budget_max: null } as ParticipantContext['participant'],
  preferences: [],
  dealBreakers: [],
});
const cell = (secs: number): DecisionTravelEstimate =>
  ({ status: 'ok', duration_seconds: secs, travel_mode: 'driving' }) as unknown as DecisionTravelEstimate;

describe('computeFairness', () => {
  it('computes the full metric bundle including p50', () => {
    const participants = [p(1), p(2), p(3)];
    const est = new Map<number, DecisionTravelEstimate>([[1, cell(600)], [2, cell(900)], [3, cell(1200)]]);
    const { metrics, score } = computeFairness({ participants, estimateByParticipant: est });
    expect(metrics).toMatchObject({ mean: 900, max: 1200, min: 600, range: 600, p50: 900, limitViolationCount: 0 });
    expect(metrics!.variance).toBeCloseTo(60000);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('counts hard-limit violations and drags the score down for them', () => {
    const participants = [p(1, 10), p(2)]; // P1 caps at 10 min but must travel 20
    const est = new Map<number, DecisionTravelEstimate>([[1, cell(1200)], [2, cell(600)]]);
    const { metrics, score } = computeFairness({ participants, estimateByParticipant: est });
    expect(metrics!.limitViolationCount).toBe(1);
    const free = computeFairness({ participants: [p(1), p(2)], estimateByParticipant: est });
    expect(score).toBeLessThan(free.score);
  });

  it('an extreme sacrifice scores worse than an equal-mean fair split', () => {
    const participants = [p(1), p(2), p(3)];
    // Same mean (900s): one person travelling 2400s vs everyone at 900s.
    const skewed = computeFairness({
      participants,
      estimateByParticipant: new Map([[1, cell(600)], [2, cell(0)], [3, cell(2100)]]),
    });
    const even = computeFairness({
      participants,
      estimateByParticipant: new Map([[1, cell(900)], [2, cell(900)], [3, cell(900)]]),
    });
    expect(skewed.score).toBeLessThan(even.score);
  });

  it('no usable cells: neutral score, no metrics', () => {
    const { metrics, score } = computeFairness({ participants: [p(1)], estimateByParticipant: new Map() });
    expect(metrics).toBeNull();
    expect(score).toBe(0.3);
  });
});
