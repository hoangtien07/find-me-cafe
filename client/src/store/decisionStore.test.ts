import { describe, it, expect, beforeEach } from 'vitest'
import { useDecisionStore } from './decisionStore'
import type {
  DecisionCandidate,
  DecisionParticipant,
  DecisionSelection,
  DecisionSession,
} from '@trek/shared'

const session = (over: Partial<DecisionSession> = {}): DecisionSession => ({
  id: 2,
  trip_id: 11,
  status: 'collecting',
  occasion: null,
  scheduled_at: null,
  travel_mode: 'driving',
  currency: 'VND',
  created_by_user_id: 1,
  created_at: '2026-09-24 08:00:00',
  updated_at: '2026-09-24 08:00:00',
  ...over,
})

const participant = (id: number, over: Partial<DecisionParticipant> = {}): DecisionParticipant => ({
  id,
  decision_session_id: 2,
  display_name: `P${id}`,
  origin_lat: null,
  origin_lng: null,
  origin_label: null,
  max_travel_minutes: null,
  budget_min: null,
  budget_max: null,
  submitted_at: null,
  created_at: '2026-09-24 08:00:00',
  updated_at: '2026-09-24 08:00:00',
  ...over,
})

const candidate = (id: number, over: Partial<DecisionCandidate> = {}): DecisionCandidate => ({
  id,
  decision_session_id: 2,
  place_id: id + 100,
  source: 'search',
  added_by_type: 'host',
  added_by_id: 1,
  snapshot: { name: `Cafe ${id}` },
  created_at: '2026-09-24 08:00:00',
  ...over,
})

const selection = (over: Partial<DecisionSelection> = {}): DecisionSelection => ({
  id: 9,
  decision_session_id: 2,
  candidate_id: 5,
  recommendation_run_id: 7,
  selected_by_user_id: 1,
  selected_at: '2026-09-24 09:00:00',
  ...over,
})

beforeEach(() => {
  useDecisionStore.getState().reset()
})

describe('decisionStore > applyEvent', () => {
  it('FE-DEC-001 upserts participants on join and update', () => {
    useDecisionStore.getState().openSession(session())
    useDecisionStore.getState().applyEvent({ type: 'decision:participant-joined', participant: participant(1) })
    useDecisionStore.getState().applyEvent({
      type: 'decision:participant-updated',
      participant: participant(1, { display_name: 'An', budget_max: 100000 }),
    })
    const ps = useDecisionStore.getState().participants
    expect(ps).toHaveLength(1)
    expect(ps[0]?.display_name).toBe('An')
    expect(ps[0]?.budget_max).toBe(100000)
  })

  it('FE-DEC-002 adds and removes candidates', () => {
    useDecisionStore.getState().openSession(session())
    useDecisionStore.getState().applyEvent({ type: 'decision:candidate-added', candidate: candidate(5) })
    useDecisionStore.getState().applyEvent({ type: 'decision:candidate-added', candidate: candidate(6) })
    useDecisionStore.getState().applyEvent({ type: 'decision:candidate-removed', decisionSessionId: 2, candidateId: 5 })
    const cs = useDecisionStore.getState().candidates
    expect(cs.map(c => c.id)).toEqual([6])
  })

  it('FE-DEC-003 ignores events that name a different decision session', () => {
    useDecisionStore.getState().openSession(session())
    useDecisionStore.getState().applyEvent({ type: 'decision:participant-joined', participant: participant(1, { decision_session_id: 99 }) })
    useDecisionStore.getState().applyEvent({ type: 'decision:candidate-removed', decisionSessionId: 99, candidateId: 5 })
    useDecisionStore.getState().applyEvent({ type: 'decision:status-updated', decisionSessionId: 99, status: 'closed' })
    expect(useDecisionStore.getState().participants).toHaveLength(0)
    expect(useDecisionStore.getState().session?.status).toBe('collecting')
  })

  it('FE-DEC-004 does nothing until a session is open', () => {
    useDecisionStore.getState().applyEvent({ type: 'decision:participant-joined', participant: participant(1) })
    expect(useDecisionStore.getState().participants).toHaveLength(0)
  })

  it('FE-DEC-005 status updates patch the open session row', () => {
    useDecisionStore.getState().openSession(session())
    useDecisionStore.getState().applyEvent({ type: 'decision:status-updated', decisionSessionId: 2, status: 'resolving' })
    expect(useDecisionStore.getState().session?.status).toBe('resolving')
  })

  it('FE-DEC-006 recommendation-ready only hands over the run id', () => {
    useDecisionStore.getState().openSession(session())
    useDecisionStore.getState().applyEvent({ type: 'decision:recommendation-ready', decisionSessionId: 2, runId: 7 })
    expect(useDecisionStore.getState().pendingResultRunId).toBe(7)
  })

  it('FE-DEC-007 selection flips the session to selected and stores the row', () => {
    useDecisionStore.getState().openSession(session({ status: 'resolved' }))
    useDecisionStore.getState().applyEvent({ type: 'decision:selected', decisionSessionId: 2, selection: selection() })
    expect(useDecisionStore.getState().selection?.candidate_id).toBe(5)
    expect(useDecisionStore.getState().session?.status).toBe('selected')
  })

  it('FE-DEC-008 reset clears everything between rooms', () => {
    useDecisionStore.getState().openSession(session())
    useDecisionStore.getState().applyEvent({ type: 'decision:participant-joined', participant: participant(1) })
    useDecisionStore.getState().reset()
    const s = useDecisionStore.getState()
    expect(s.sessionId).toBeNull()
    expect(s.participants).toHaveLength(0)
    // A stale event after reset must not resurrect the room.
    useDecisionStore.getState().applyEvent({ type: 'decision:participant-joined', participant: participant(1) })
    expect(useDecisionStore.getState().participants).toHaveLength(0)
  })
})
