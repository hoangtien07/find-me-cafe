import type {
  DecisionCandidate,
  DecisionSession,
  DecisionTravelEstimate,
} from '@trek/shared';
import type { ConstraintFinding, ParticipantContext } from './resolver.types';

/**
 * Hard-constraint engine (spec §14): evaluates one candidate against every
 * participant's hard rules. A violation makes the candidate ineligible; a
 * check that lacks evidence lands in `unknowns` — UNKNOWN is never silently
 * PASS, it travels with the result row so the UI can say "we couldn't verify
 * opening hours" instead of implying it.
 *
 * V1 checks:
 * - veto_category deal-breakers (participant's explicit "không quán bar")
 * - max_travel_minutes per participant (from the persisted estimate cell)
 * - budget_max per participant when the candidate's price is known
 * - opening-hours evidence when the session is scheduled for a time
 */
export function evaluateConstraints(input: {
  candidate: DecisionCandidate;
  session: DecisionSession;
  participants: ParticipantContext[];
  estimateByParticipant: Map<number, DecisionTravelEstimate | null>;
}): { eligible: boolean; violations: ConstraintFinding[]; unknowns: ConstraintFinding[] } {
  const violations: ConstraintFinding[] = [];
  const unknowns: ConstraintFinding[] = [];
  const { candidate, session, participants, estimateByParticipant } = input;
  const snap = candidate.snapshot;
  const category = (snap?.category ?? '').toLowerCase();

  for (const { participant, dealBreakers } of participants) {
    // Explicit participant veto: deal-breaker whose category matches.
    for (const db of dealBreakers) {
      if (db.type !== 'veto_category') continue;
      const vetoed = categoryValue(db.value);
      if (vetoed === null) {
        unknowns.push({ type: 'veto_category', detail: 'veto has no category to compare', participant_id: participant.id });
        continue;
      }
      if (category && vetoed === category) {
        violations.push({
          type: 'veto_category',
          detail: `${participant.display_name} vetoes ${vetoed}`,
          participant_id: participant.id,
        });
      } else if (!category) {
        unknowns.push({
          type: 'veto_category',
          detail: `cannot check ${participant.display_name}'s ${vetoed} veto — venue category unknown`,
          participant_id: participant.id,
        });
      }
    }

    // Hard travel cap.
    const cap = participant.max_travel_minutes;
    if (cap !== null && cap !== undefined) {
      const est = estimateByParticipant.get(participant.id);
      if (!est || est.status !== 'ok' || est.duration_seconds === null) {
        unknowns.push({
          type: 'max_travel',
          detail: `no usable travel estimate for ${participant.display_name}`,
          participant_id: participant.id,
        });
      } else if (est.duration_seconds > cap * 60) {
        violations.push({
          type: 'max_travel',
          detail: `${participant.display_name} would travel ${Math.round(est.duration_seconds / 60)}m > ${cap}m cap`,
          participant_id: participant.id,
        });
      }
    }

    // Explicit hard budget: participant set budget_max and the venue's price is known.
    if (participant.budget_max !== null && participant.budget_max !== undefined) {
      if (snap?.price === null || snap?.price === undefined) {
        unknowns.push({
          type: 'budget',
          detail: `price unknown — ${participant.display_name}'s ${participant.budget_max} cap unverifiable`,
          participant_id: participant.id,
        });
      } else if (snap.price > participant.budget_max) {
        violations.push({
          type: 'budget',
          detail: `price ${snap.price} > ${participant.display_name}'s budget ${participant.budget_max}`,
          participant_id: participant.id,
        });
      }
    }
  }

  // Closed-at-time evidence: only when the outing is scheduled. V1 has no
  // opening-hours source — when scheduled, the missing evidence is UNKNOWN.
  if (session.scheduled_at && (snap?.opening_hours === null || snap?.opening_hours === undefined)) {
    unknowns.push({
      type: 'opening_hours',
      detail: 'session is scheduled but venue opening hours are unknown',
    });
  }

  return { eligible: violations.length === 0, violations, unknowns };
}

/** Extract the vetoed category string from a deal-breaker's value payload. */
function categoryValue(value: unknown): string | null {
  if (value && typeof value === 'object' && 'category' in value) {
    const c = (value as { category: unknown }).category;
    return typeof c === 'string' ? c.toLowerCase() : null;
  }
  if (typeof value === 'string') return value.toLowerCase();
  return null;
}
