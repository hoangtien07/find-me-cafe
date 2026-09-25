import type { DecisionCandidate, DecisionExplanation } from '@trek/shared';
import type { ConstraintFinding, DimensionScores, ParticipantContext } from './resolver.types';
import type { DecisionTravelEstimate } from '@trek/shared';
import type { FairnessMetrics } from './fairness-engine';

/**
 * Structured explanation (spec §16): consumes ranking evidence, never invents
 * numbers. The headline names the fairness win in the spec's user-facing
 * Vietnamese; strengths list what checked out; tradeoffs name what the group
 * gives up (including UNKNOWN evidence, which is never silently PASS);
 * travel_times is the per-participant evidence row. No fake precision, no LLM.
 */
export function explainCandidate(input: {
  candidate: DecisionCandidate;
  participants: ParticipantContext[];
  estimateByParticipant: Map<number, DecisionTravelEstimate | null>;
  metrics: FairnessMetrics | null;
  unknowns: ConstraintFinding[];
  scores: DimensionScores;
}): DecisionExplanation {
  const { participants, estimateByParticipant, metrics, unknowns, scores } = input;

  const travel_times = participants.map(({ participant }) => {
    const est = estimateByParticipant.get(participant.id);
    return {
      participant_id: participant.id,
      display_name: participant.display_name,
      duration_seconds: est && est.status === 'ok' ? est.duration_seconds : null,
      status: est?.status ?? 'missing',
      travel_mode: est?.travel_mode ?? null,
    };
  });

  const headline =
    metrics && metrics.range <= 5 * 60
      ? 'Cân bằng nhất cho nhóm'
      : metrics && metrics.limitViolationCount === 0
        ? 'Nhanh nhất cho cả nhóm'
        : 'Lựa chọn thỏa hiệp';

  const strengths: string[] = [];
  if (metrics && metrics.limitViolationCount === 0) {
    strengths.push('tất cả trong giới hạn di chuyển');
  }
  const budgets = participants
    .map((p) => p.participant.budget_max)
    .filter((b): b is number => b !== null && b !== undefined);
  const price = input.candidate.snapshot?.price;
  if (budgets.length > 0 && typeof price === 'number' && price <= Math.max(...budgets)) {
    strengths.push('hợp budget');
  }
  if (scores.groupFit >= 0.75) strengths.push('phù hợp sở thích nhóm');
  if (scores.placeFit >= 0.8) strengths.push('đánh giá cao');
  // M2-08 — typed VenueContext evidence reads better than the aggregate: name
  // the matched dims, name the missed ones among the tradeoffs.
  for (const label of (scores.contextMatched ?? []).slice(0, 2)) {
    strengths.push(`khớp: ${label}`);
  }

  const tradeoffs: string[] = [];
  if (metrics && metrics.range > 15 * 60) {
    tradeoffs.push('chênh lệch thời gian di chuyển giữa các thành viên lớn');
  }
  if (scores.groupFit < 0.5) tradeoffs.push('ít khớp sở thích đã khai báo');
  if (scores.placeFit < 0.6) tradeoffs.push('chất lượng quán chưa nổi bật');
  for (const label of (scores.contextMissed ?? []).slice(0, 2)) {
    tradeoffs.push(`không khớp: ${label}`);
  }
  for (const u of unknowns.slice(0, 3)) {
    tradeoffs.push(`chưa kiểm chứng: ${u.detail}`);
  }

  return { headline, strengths, tradeoffs, travel_times };
}
