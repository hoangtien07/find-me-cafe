import type { DecisionCandidate, DecisionCandidateSnapshot } from '@trek/shared';
import type { DimensionScores, ParticipantContext } from './resolver.types';

/**
 * The resolver-v2 weighting — strategy data, not UI values (plan §14). Travel
 * dominates because a venue one person loves but can't reach fails the group.
 * Stamped on every recommendation_run (strategy_version) and mixed into the
 * input hash, so a weights bump produces different run ids honestly.
 */
export const RESOLVER_STRATEGY = 'resolver-v2';
export const RESOLVER_V2_WEIGHTS = {
  place: 0.15,
  group: 0.25,
  travel: 0.3,
  context: 0.15,
  trust: 0.15,
} as const;

/**
 * Score one candidate across the five soft dimensions (spec §14). All outputs
 * are [0,1]; a candidate that fails hard constraints still gets scored — the
 * sort puts eligibles first — so its row stays explainable.
 */
export function scoreCandidate(input: {
  candidate: DecisionCandidate;
  participants: ParticipantContext[];
  fairnessScore: number;
}): DimensionScores & { totalScore: number } {
  const { candidate, participants, fairnessScore } = input;
  const snap: Partial<DecisionCandidateSnapshot> = candidate.snapshot ?? {};

  // PlaceFit: venue's own quality signal — rating normalized, neutral floor.
  const placeFit = typeof snap.rating === 'number' ? clamp01(snap.rating / 5) : 0.5;

  // GroupFit: fraction of stated preferences the venue plausibly satisfies —
  // keyword matching against name/category/description. Participants without
  // preferences count neutral.
  let scored = 0;
  let hits = 0;
  const haystack = `${snap.name ?? ''} ${snap.category ?? ''} ${snap.description ?? ''}`.toLowerCase();
  for (const { preferences } of participants) {
    if (preferences.length === 0) continue;
    scored++;
    const want = preferences.some((p) =>
      haystack.includes(p.value.toLowerCase()) || haystack.includes(p.key.toLowerCase()),
    );
    if (want) hits++;
  }
  const groupFit = scored === 0 ? 0.5 : hits / scored;

  // ContextFit: the session's travel-mode/occasion frame. In V1 the only
  // explicit context signals are budget overlap and occasion keywords.
  let contextFit = 0.5;
  const budgets = participants
    .map((p) => p.participant.budget_max)
    .filter((b): b is number => b !== null && b !== undefined);
  if (typeof snap.price === 'number' && budgets.length > 0) {
    contextFit += snap.price <= Math.max(...budgets) ? 0.25 : -0.25;
  }
  contextFit = clamp01(contextFit);

  // Trust: how much of the evidence the resolver leaned on actually exists.
  const evidenceFields = [snap.lat, snap.lng, snap.category, snap.rating, snap.price, snap.address];
  const trustScore = evidenceFields.filter((v) => v !== null && v !== undefined).length / evidenceFields.length;

  const travelFairness = clamp01(fairnessScore);
  const totalScore =
    RESOLVER_V2_WEIGHTS.place * placeFit +
    RESOLVER_V2_WEIGHTS.group * groupFit +
    RESOLVER_V2_WEIGHTS.travel * travelFairness +
    RESOLVER_V2_WEIGHTS.context * contextFit +
    RESOLVER_V2_WEIGHTS.trust * trustScore;

  return { placeFit, groupFit, travelFairness, contextFit, trustScore, totalScore };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
