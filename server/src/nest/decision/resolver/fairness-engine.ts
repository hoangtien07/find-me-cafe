import type { ParticipantContext } from './resolver.types';
import type { DecisionTravelEstimate } from '@trek/shared';

/** The metrics spec §15 mandates at minimum. */
export interface FairnessMetrics {
  mean: number;
  max: number;
  min: number;
  range: number;
  variance: number;
  limitViolationCount: number;
}

/**
 * HYBRID fairness (spec §15 V1 default): rewards a low group mean while
 * strongly penalizing the two failure shapes groups actually reject —
 * extreme sacrifice by one participant (max far above the rest) and hard
 * limit violations. Returns a [0,1] score plus the raw metrics the
 * explanation cites.
 *
 * Deterministic normalization: the norm is 45 minutes — a comfortable urban
 * trip; a group whose mean is at the norm scores ~0.5 on the base term.
 */
export function computeFairness(input: {
  participants: ParticipantContext[];
  estimateByParticipant: Map<number, DecisionTravelEstimate | null>;
}): { metrics: FairnessMetrics | null; score: number } {
  const durations: number[] = [];
  let limitViolationCount = 0;
  for (const { participant } of input.participants) {
    const est = input.estimateByParticipant.get(participant.id);
    if (!est || est.status !== 'ok' || est.duration_seconds === null) continue;
    durations.push(est.duration_seconds);
    if (
      participant.max_travel_minutes !== null &&
      participant.max_travel_minutes !== undefined &&
      est.duration_seconds > participant.max_travel_minutes * 60
    ) {
      limitViolationCount++;
    }
  }
  if (durations.length === 0) {
    // No travel evidence at all: neutral-low score, no metrics to cite.
    return { metrics: null, score: 0.3 };
  }

  const n = durations.length;
  const mean = durations.reduce((a, b) => a + b, 0) / n;
  const max = Math.max(...durations);
  const min = Math.min(...durations);
  const range = max - min;
  const variance = durations.reduce((acc, d) => acc + (d - mean) ** 2, 0) / n;
  const metrics: FairnessMetrics = { mean, max, min, range, variance, limitViolationCount };

  const NORM_SEC = 45 * 60;
  const base = Math.max(0, 1 - mean / NORM_SEC); // group-average term
  const sorted = [...durations].sort((a, b) => a - b);
  const median = sorted[Math.floor(n / 2)]!;
  const sacrifice = Math.max(0, (max - median) / NORM_SEC); // one person left far out
  const inequality = Math.min(1, Math.sqrt(variance) / NORM_SEC);
  const limitPenalty = Math.min(1, limitViolationCount * 0.5);

  const score = Math.max(
    0,
    Math.min(1, base * 0.6 - sacrifice * 1.2 - inequality * 0.4 - limitPenalty + 0.4),
  );
  return { metrics, score };
}
