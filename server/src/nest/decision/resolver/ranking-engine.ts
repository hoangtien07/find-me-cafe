import type { DecisionCandidate, DecisionCandidateSnapshot, DecisionVenueContext } from '@trek/shared';
import type { DimensionScores, ParticipantContext } from './resolver.types';

/**
 * M2-08 — maps a stated preference onto a deterministic VenueContext
 * dimension when one exists. Typed hits/misses are real evidence; a null
 * return means "no typed dimension applies — let the snapshot haystack
 * decide". All comparisons are lowercase-contains so 'coffee' hits 'espresso
 * bar' only through tags, not through noise words.
 */
const NOISE_WANTS: Record<string, 'QUIET' | 'MODERATE' | 'LIVELY'> = {
  quiet: 'QUIET',
  'yên tĩnh': 'QUIET',
  êm: 'QUIET',
  'thư giãn': 'QUIET',
  moderate: 'MODERATE',
  'vừa vặn': 'MODERATE',
  lively: 'LIVELY',
  'sôi động': 'LIVELY',
  'náo nhiệt': 'LIVELY',
};
const NOISE_LABEL: Record<string, string> = { QUIET: 'yên tĩnh', MODERATE: 'vừa vặn', LIVELY: 'sôi động' };

const BAND_WANTS: Record<string, 'LOW' | 'MEDIUM' | 'HIGH'> = {
  low: 'LOW',
  rẻ: 'LOW',
  'bình dân': 'LOW',
  medium: 'MEDIUM',
  'tầm trung': 'MEDIUM',
  high: 'HIGH',
  sang: 'HIGH',
  'cao cấp': 'HIGH',
};
const BAND_LABEL: Record<string, string> = { LOW: 'giá rẻ', MEDIUM: 'tầm trung', HIGH: 'cao cấp' };

const FRIENDLINESS_KEYS: Record<string, 'group_friendliness' | 'laptop_friendliness' | 'photo_friendliness'> = {
  group: 'group_friendliness',
  'nhóm': 'group_friendliness',
  'đông người': 'group_friendliness',
  laptop: 'laptop_friendliness',
  work: 'laptop_friendliness',
  'làm việc': 'laptop_friendliness',
  photo: 'photo_friendliness',
  'ảnh': 'photo_friendliness',
  'sống ảo': 'photo_friendliness',
  'chụp ảnh': 'photo_friendliness',
};
const FRIENDLINESS_LABEL: Record<string, string> = {
  group_friendliness: 'hợp nhóm',
  laptop_friendliness: 'làm việc được',
  photo_friendliness: 'sống ảo đẹp',
};
const FRIENDLINESS_OK = 3;

const PARKING_RANK: Record<string, number> = { UNKNOWN: -1, NONE: 0, LIMITED: 1, EASY: 2 };
const PARKING_WANTS: Record<string, 'LIMITED' | 'EASY'> = {
  easy: 'EASY',
  'dễ': 'EASY',
  'có': 'EASY',
  limited: 'LIMITED',
  'hạn chế': 'LIMITED',
};
const PARKING_LABEL: Record<string, string> = { NONE: 'không chỗ đỗ', LIMITED: 'đỗ xe hạn chế', EASY: 'đỗ xe dễ' };

/** Deterministic match of one preference against the VenueContext overlay. */
function matchVenueContext(
  pref: { key: string; value: string },
  ctx: DecisionVenueContext | null | undefined,
): { matched: boolean; label: string } | null {
  if (!ctx) return null;
  const k = pref.key.toLowerCase();
  const v = pref.value.toLowerCase();
  const tags = [...ctx.vibe_tags, ...ctx.drink_tags, ...ctx.occasion_tags].map((t) => t.toLowerCase());

  // A descriptor tag containing the wanted word is a hit no matter which key
  // the member picked — tags are the flexible half of the overlay.
  if (v && tags.some((t) => t.includes(v) || v.includes(t))) return { matched: true, label: pref.value };

  const noise = NOISE_WANTS[k] ?? NOISE_WANTS[v];
  if (noise !== undefined && ctx.noise_level !== 'UNKNOWN') {
    return { matched: ctx.noise_level === noise, label: NOISE_LABEL[ctx.noise_level]! };
  }

  const band = BAND_WANTS[k] ?? BAND_WANTS[v];
  if (band !== undefined && ctx.price_band !== 'UNKNOWN') {
    return { matched: ctx.price_band === band, label: BAND_LABEL[ctx.price_band]! };
  }

  const dim = FRIENDLINESS_KEYS[k] ?? FRIENDLINESS_KEYS[v];
  if (dim !== undefined && ctx[dim] !== null) {
    return { matched: ctx[dim]! >= FRIENDLINESS_OK, label: FRIENDLINESS_LABEL[dim]! };
  }

  if ((k === 'parking' || PARKING_WANTS[v] !== undefined) && ctx.parking !== 'UNKNOWN') {
    const want = PARKING_WANTS[v] ?? 'EASY';
    return { matched: PARKING_RANK[ctx.parking]! >= PARKING_RANK[want]!, label: PARKING_LABEL[ctx.parking]! };
  }

  return null;
}

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

  // GroupFit: fraction of stated preferences the venue plausibly satisfies.
  // The VenueContext overlay answers deterministically where it has typed
  // evidence (M2-08); everything it can't answer falls back to the snapshot
  // keyword match. Participants without preferences count neutral.
  let scored = 0;
  let hits = 0;
  const contextMatched = new Set<string>();
  const contextMissed = new Set<string>();
  const haystack = `${snap.name ?? ''} ${snap.category ?? ''} ${snap.description ?? ''}`.toLowerCase();
  for (const { preferences } of participants) {
    if (preferences.length === 0) continue;
    scored++;
    const want = preferences.some((p) => {
      const typed = matchVenueContext(p, candidate.venue_context);
      if (typed) {
        (typed.matched ? contextMatched : contextMissed).add(typed.label);
        return typed.matched;
      }
      return haystack.includes(p.value.toLowerCase()) || haystack.includes(p.key.toLowerCase());
    });
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

  return {
    placeFit,
    groupFit,
    travelFairness,
    contextFit,
    trustScore,
    totalScore,
    contextMatched: [...contextMatched],
    contextMissed: [...contextMissed],
  };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
