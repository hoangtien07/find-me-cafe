// FE-REPO-DEC-001 to FE-REPO-DEC-003
import { describe, it, expect, beforeEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../tests/helpers/msw/server'
import { decisionRepo } from './decisionRepo'
import { useDecisionStore } from '../store/decisionStore'
import type {
  DecisionCandidate,
  DecisionParticipant,
  DecisionParticipantRosterEntry,
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

const rosterEntry = (id: number, over: Partial<DecisionParticipantRosterEntry> = {}): DecisionParticipantRosterEntry => ({
  id,
  display_name: `P${id}`,
  submitted_at: null,
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

const noRun = () => HttpResponse.json({ error: 'No completed run' }, { status: 404 })
const noVotes = () => HttpResponse.json({ votes: [], total: 0 })

beforeEach(() => {
  useDecisionStore.getState().reset()
})

describe('decisionRepo.open', () => {
  it('FE-REPO-DEC-001 loads the room including its locked-in selection', async () => {
    server.use(
      http.get('/api/decisions/2', () =>
        HttpResponse.json({
          decision: session({ status: 'selected' }),
          participants: [rosterEntry(1)],
          selection: selection(),
        }),
      ),
      http.get('/api/decisions/2/candidates', () => HttpResponse.json({ candidates: [candidate(5)] })),
      http.get('/api/decisions/2/recommendations/latest', noRun),
      http.get('/api/decisions/2/votes', noVotes),
    )

    const decision = await decisionRepo.open(2)

    expect(decision.id).toBe(2)
    const s = useDecisionStore.getState()
    expect(s.session?.status).toBe('selected')
    expect(s.participants).toHaveLength(1)
    expect(s.candidates).toHaveLength(1)
    expect(s.latestResult).toBeNull()
    expect(s.selection?.candidate_id).toBe(5)
  })

  it('FE-REPO-DEC-002 refetches when a decision:* event lands mid-fetch', async () => {
    // Room already open (the reconnect re-pull case): a participant joins
    // while the first snapshot is in flight. The join event bumps eventSeq,
    // so open() pulls again instead of applying the stale snapshot over it.
    useDecisionStore.getState().openSession(session())
    useDecisionStore.getState().setParticipants([rosterEntry(1)])

    const joined = participant(2, { display_name: 'Bình' })
    let getCalls = 0
    server.use(
      http.get('/api/decisions/2', () => {
        getCalls++
        if (getCalls === 1) {
          // The join event arrives before the first response resolves; the
          // server already knows the row, so the second snapshot carries it.
          useDecisionStore.getState().applyEvent({ type: 'decision:participant-joined', participant: joined })
          return HttpResponse.json({ decision: session(), participants: [rosterEntry(1)], selection: null })
        }
        return HttpResponse.json({
          decision: session(),
          participants: [rosterEntry(1), rosterEntry(2)],
          selection: null,
        })
      }),
      http.get('/api/decisions/2/candidates', () => HttpResponse.json({ candidates: [] })),
      http.get('/api/decisions/2/recommendations/latest', noRun),
      http.get('/api/decisions/2/votes', noVotes),
    )

    await decisionRepo.open(2)

    expect(getCalls).toBe(2)
    const ids = useDecisionStore.getState().participants.map(p => Number(p.id))
    expect(ids).toEqual([1, 2])
  })

  it('FE-REPO-DEC-003 replaces a stale selection with the server state', async () => {
    // The selection moved while the socket was down; the re-pull must not
    // keep the old locked-in venue.
    useDecisionStore.getState().openSession(session({ status: 'selected' }))
    useDecisionStore.getState().setSelection(selection({ candidate_id: 5 }))

    server.use(
      http.get('/api/decisions/2', () =>
        HttpResponse.json({
          decision: session({ status: 'selected' }),
          participants: [],
          selection: selection({ id: 10, candidate_id: 9 }),
        }),
      ),
      http.get('/api/decisions/2/candidates', () => HttpResponse.json({ candidates: [candidate(9, { place_id: 109 })] })),
      http.get('/api/decisions/2/recommendations/latest', noRun),
      http.get('/api/decisions/2/votes', noVotes),
    )

    await decisionRepo.open(2)

    expect(useDecisionStore.getState().selection?.candidate_id).toBe(9)
  })
})
