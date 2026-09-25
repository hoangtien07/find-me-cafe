import type {
  DecisionCandidate,
  DecisionSession,
  DecisionTravelEstimate,
} from '@trek/shared';
import type { ConstraintFinding, ParticipantContext } from './resolver.types';

/**
 * Hard-constraint engine V2 (plan §15): evaluates one candidate against every
 * participant's hard rules. A violation makes the candidate ineligible; a
 * check that lacks evidence lands in `unknowns` — UNKNOWN is never silently
 * PASS, it travels with the result row so the UI can say "we couldn't verify
 * opening hours" instead of implying it.
 *
 * V2 finding families (stored `type` values, all bearing candidate_id /
 * result / source):
 * - explicit_veto — participant deal-breaker whose category matches
 * - no_route — the matrix cell says unreachable (fail) or can't be
 *   verified (unknown, e.g. provider error)
 * - max_travel_exceeded — past a participant's hard travel cap
 * - hard_budget_exceeded — known price past a participant's hard budget
 * - mandatory_attribute_missing — an is_hard preference the venue provably
 *   lacks (fail) or can't be checked for (unknown)
 * - closed_at_decision_time — venue shut at the scheduled time (fail),
 *   hours unverifiable (unknown)
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
  const forCandidate = (f: Omit<ConstraintFinding, 'candidate_id'>): ConstraintFinding => ({
    ...f,
    candidate_id: candidate.id,
  });
  const fail = (f: Omit<ConstraintFinding, 'candidate_id'>) =>
    violations.push(forCandidate({ ...f, result: 'fail' }));
  const unknown = (f: Omit<ConstraintFinding, 'candidate_id'>) =>
    unknowns.push(forCandidate({ ...f, result: 'unknown' }));

  for (const { participant, preferences, dealBreakers } of participants) {
    // EXPLICIT_VETO: deal-breaker whose category matches.
    for (const db of dealBreakers) {
      if (db.type !== 'veto_category') continue;
      const vetoed = categoryValue(db.value);
      if (vetoed === null) {
        unknown({ type: 'explicit_veto', detail: 'veto has no category to compare', participant_id: participant.id, source: 'participant' });
        continue;
      }
      if (category && vetoed === category) {
        fail({
          type: 'explicit_veto',
          detail: `${participant.display_name} vetoes ${vetoed}`,
          participant_id: participant.id,
          source: 'participant',
        });
      } else if (!category) {
        unknown({
          type: 'explicit_veto',
          detail: `cannot check ${participant.display_name}'s ${vetoed} veto — venue category unknown`,
          participant_id: participant.id,
          source: 'participant',
        });
      }
    }

    // NO_ROUTE + MAX_TRAVEL_EXCEEDED from the persisted estimate cell.
    const est = estimateByParticipant.get(participant.id);
    const travelVerified = est !== null && est !== undefined && est.status === 'ok' && est.duration_seconds !== null;
    if (!est || (est.status !== 'ok' && est.status !== 'no_route')) {
      unknown({
        type: 'no_route',
        detail: `travel time for ${participant.display_name} unverifiable (${est?.status ?? 'no estimate'})`,
        participant_id: participant.id,
        source: 'matrix',
      });
    } else if (est.status === 'no_route') {
      fail({
        type: 'no_route',
        detail: `no route for ${participant.display_name}`,
        participant_id: participant.id,
        source: 'matrix',
      });
    }
    const cap = participant.max_travel_minutes;
    if (cap !== null && cap !== undefined && travelVerified) {
      if (est!.duration_seconds! > cap * 60) {
        fail({
          type: 'max_travel_exceeded',
          detail: `${participant.display_name} would travel ${Math.round(est!.duration_seconds! / 60)}m > ${cap}m cap`,
          participant_id: participant.id,
          source: 'matrix',
        });
      }
    }

    // HARD_BUDGET_EXCEEDED: participant set budget_max and the venue's price is known.
    if (participant.budget_max !== null && participant.budget_max !== undefined) {
      if (snap?.price === null || snap?.price === undefined) {
        unknown({
          type: 'hard_budget_exceeded',
          detail: `price unknown — ${participant.display_name}'s ${participant.budget_max} cap unverifiable`,
          participant_id: participant.id,
          source: 'snapshot',
        });
      } else if (snap.price > participant.budget_max) {
        fail({
          type: 'hard_budget_exceeded',
          detail: `price ${snap.price} > ${participant.display_name}'s budget ${participant.budget_max}`,
          participant_id: participant.id,
          source: 'snapshot',
        });
      }
    }

    // MANDATORY_ATTRIBUTE_MISSING: an is_hard preference the venue provably
    // lacks, or one we cannot check. Facts vocabulary is bounded
    // (decisionCandidateFactsSchema); free-text must-haves match the venue
    // haystack or stay UNKNOWN.
    const haystack = `${snap?.name ?? ''} ${snap?.category ?? ''} ${snap?.description ?? ''}`.toLowerCase();
    for (const pref of preferences) {
      if (!pref.is_hard) continue;
      const factKey = FACT_ALIASES[pref.key.toLowerCase()] ?? FACT_ALIASES[pref.value.toLowerCase()];
      if (factKey) {
        const fact = snap?.facts?.[factKey as keyof NonNullable<NonNullable<typeof snap>['facts']>];
        if (fact === null || fact === undefined) {
          unknown({
            type: 'mandatory_attribute_missing',
            detail: `${participant.display_name} requires '${pref.value}' — venue evidence missing`,
            participant_id: participant.id,
            source: 'snapshot',
          });
        } else if (!factSaysYes(fact)) {
          fail({
            type: 'mandatory_attribute_missing',
            detail: `venue lacks ${participant.display_name}'s must-have '${pref.value}'`,
            participant_id: participant.id,
            source: 'snapshot',
          });
        }
      } else if (!haystack.includes(pref.value.toLowerCase()) && !haystack.includes(pref.key.toLowerCase())) {
        unknown({
          type: 'mandatory_attribute_missing',
          detail: `cannot verify ${participant.display_name}'s must-have '${pref.value}'`,
          participant_id: participant.id,
          source: 'participant',
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
      unknown({ type: 'closed_at_decision_time', detail: 'session time unparseable — hours unverifiable', source: 'session' });
    } else if (specialDays && specialDays.length > 0 && specialDays.includes(toIsoDay(when))) {
      unknown({ type: 'closed_at_decision_time', detail: 'venue has special hours that day — weekly pattern does not apply', source: 'snapshot' });
    } else if (!periods || periods.length === 0) {
      unknown({ type: 'closed_at_decision_time', detail: 'session is scheduled but venue opening hours are unknown', source: 'snapshot' });
    } else if (!isOpenAt(periods, when)) {
      fail({ type: 'closed_at_decision_time', detail: 'venue is closed at the scheduled time', source: 'snapshot' });
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

/**
 * Must-have words → the bounded candidate-facts vocabulary. Vietnamese
 * aliases included because participant context text is VN-first.
 */
const FACT_ALIASES: Record<string, string> = {
  wifi: 'internet_access',
  internet: 'internet_access',
  'mạng': 'internet_access',
  outdoor: 'outdoor_seating',
  'ngoài trời': 'outdoor_seating',
  'sân vườn': 'outdoor_seating',
  takeaway: 'takeaway',
  'mang về': 'takeaway',
  delivery: 'delivery',
  'giao hàng': 'delivery',
  wheelchair: 'wheelchair',
  'xe lăn': 'wheelchair',
  vegetarian: 'vegetarian',
  chay: 'vegetarian',
  'ăn chay': 'vegetarian',
  vegan: 'vegan',
  'thuần chay': 'vegan',
};

/**
 * A fact value answers the must-have positively unless it is an explicit
 * absence ('no', 'none', false, 0). 'limited'/'wlan'/'yes' all count as yes.
 */
function factSaysYes(fact: unknown): boolean {
  if (typeof fact === 'boolean') return fact;
  if (typeof fact === 'number') return fact !== 0;
  if (typeof fact === 'string') {
    const v = fact.trim().toLowerCase();
    return v !== '' && v !== 'no' && v !== 'none' && v !== 'false' && v !== '0';
  }
  return false;
}
