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

  // CLOSED_AT_DECISION_TIME: only when the outing is scheduled. Periods are
  // evaluated against the scheduled local wall time (the product targets VN
  // groups — one timezone — so no tz lookup is needed). Missing periods are
  // UNKNOWN; a special-day override is UNKNOWN too rather than a guessed PASS.
  if (session.scheduled_at) {
    const periods = snap?.opening_periods ?? null;
    const specialDays = snap?.opening_special_days ?? null;
    const when = new Date(session.scheduled_at);
    if (Number.isNaN(when.getTime())) {
      unknowns.push({ type: 'opening_hours', detail: 'session time unparseable — hours unverifiable' });
    } else if (specialDays && specialDays.length > 0 && specialDays.includes(toIsoDay(when))) {
      unknowns.push({ type: 'opening_hours', detail: 'venue has special hours that day — weekly pattern does not apply' });
    } else if (!periods || periods.length === 0) {
      unknowns.push({ type: 'opening_hours', detail: 'session is scheduled but venue opening hours are unknown' });
    } else if (!isOpenAt(periods, when)) {
      violations.push({ type: 'closed_at_time', detail: 'venue is closed at the scheduled time' });
    }
  }

  return { eligible: violations.length === 0, violations, unknowns };
}

type OpenPeriod = { open: { day: number; hour: number; minute: number }; close?: { day: number; hour: number; minute: number } | null };

const mins = (p: { hour: number; minute: number }): number => p.hour * 60 + p.minute;
const toIsoDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Is the venue open at `when`, per provider opening periods? Period days use
 * Google's convention (Sunday = 0), matching JS getDay(). A null close means
 * "never closes"; overnight periods straddle their open day into the next.
 */
export function isOpenAt(periods: OpenPeriod[], when: Date): boolean {
  const day = when.getDay();
  const t = when.getHours() * 60 + when.getMinutes();
  return periods.some(period => {
    if (period.close == null) return true;
    const { open, close } = period;
    if (open.day === close.day) {
      return day === open.day && t >= mins(open) && t < mins(close);
    }
    // Overnight: open on its day through midnight, closing the following day.
    return (day === open.day && t >= mins(open)) || (day === close.day && t < mins(close));
  });
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
