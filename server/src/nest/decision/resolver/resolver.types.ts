import type {
  DecisionCandidate,
  DecisionConstraint,
  DecisionParticipant,
  DecisionPreference,
  DecisionSession,
  DecisionTravelEstimate,
} from '@trek/shared';

/** A participant with everything the resolver needs to judge a candidate. */
export interface ParticipantContext {
  participant: DecisionParticipant;
  preferences: DecisionPreference[];
  dealBreakers: DecisionConstraint[];
}

/** The resolver's whole view of one candidate. */
export interface CandidateEvaluation {
  candidate: DecisionCandidate;
  /** per-participant estimate cells (null when no row was persisted). */
  estimates: Map<number, DecisionTravelEstimate | null>;
  constraint: { eligible: boolean; violations: ConstraintFinding[]; unknowns: ConstraintFinding[] };
  scores: DimensionScores;
  totalScore: number;
}

/** One hard-check outcome — a violation kills, an unknown stays visible. */
export interface ConstraintFinding {
  type: string;
  detail: string;
  participant_id?: number;
  candidate_id?: number;
  result?: 'pass' | 'fail' | 'unknown';
  source?: string;
}

/** The five soft dimensions of spec §14, each normalized to [0, 1]. */
export interface DimensionScores {
  placeFit: number;
  groupFit: number;
  travelFairness: number;
  contextFit: number;
  trustScore: number;
  /** M2-08 — VN labels of the VenueContext dims that matched/missed (explainable evidence). */
  contextMatched?: string[];
  contextMissed?: string[];
}

/** What resolve() loads before the engines run. */
export interface ResolverInput {
  session: DecisionSession;
  participants: ParticipantContext[];
  candidates: DecisionCandidate[];
  estimates: DecisionTravelEstimate[];
}
