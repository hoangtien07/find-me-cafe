import { create } from 'zustand'
import type {
  DecisionCandidate,
  DecisionParticipant,
  DecisionParticipantRosterEntry,
  DecisionSelection,
  DecisionSession,
  DecisionStatus,
  RecommendationResult,
} from '@trek/shared'

/**
 * Client state for the active decision session (the "chốt quán" room).
 *
 * Decision state deliberately does NOT live in tripStore or Dexie: the
 * decision slice is a separate bounded context riding on a technical trip's
 * room, its rows are anonymous-participant data with no offline-first
 * requirement, and anonymous participants never hold a socket (spec §9).
 * Events arrive on the host's trip room and land here through the
 * useDecisionRealtime listener (api/wsEventPolicy HANDLED_OUTSIDE_TRIP_STORE).
 *
 * `sessionId` is the room this store currently mirrors; every event carries a
 * decisionSessionId / session-scoped entity so stale events from a previously
 * viewed room can't leak into the open one.
 */

interface DecisionEventMessage {
  type?: string
  participant?: DecisionParticipant
  candidate?: DecisionCandidate
  decisionSessionId?: number | string
  candidateId?: number | string
  status?: DecisionStatus
  runId?: number | string
  selection?: DecisionSelection
}

interface DecisionState {
  sessionId: number | null
  session: DecisionSession | null
  /**
   * Host view: roster entries ({id, display_name, submitted_at}); participant-
   * joined/updated events upsert full rows. Both satisfy the roster shape —
   * the room page only renders those three fields.
   */
  participants: (DecisionParticipant | DecisionParticipantRosterEntry)[]
  candidates: DecisionCandidate[]
  latestResult: RecommendationResult | null
  /** Last recommendation-ready run id — pages refetch when it changes. */
  pendingResultRunId: number | string | null
  selection: DecisionSelection | null

  reset: () => void
  /** Called by the data layer after the initial fetch wires the room. */
  openSession: (session: DecisionSession) => void
  setParticipants: (participants: (DecisionParticipant | DecisionParticipantRosterEntry)[]) => void
  setCandidates: (candidates: DecisionCandidate[]) => void
  setLatestResult: (result: RecommendationResult | null) => void
  setSelection: (selection: DecisionSelection | null) => void
  /** The decision:* WS events the useDecisionRealtime listener hands over. */
  applyEvent: (msg: DecisionEventMessage) => void
}

const upsertById = <T extends { id: number | string }>(list: T[], item: T): T[] => {
  const idx = list.findIndex(x => x.id === item.id)
  if (idx === -1) return [...list, item]
  const next = list.slice()
  next[idx] = item
  return next
}

export const useDecisionStore = create<DecisionState>()((set, get) => ({
  sessionId: null,
  session: null,
  participants: [],
  candidates: [],
  latestResult: null,
  pendingResultRunId: null,
  selection: null,

  reset: () =>
    set({
      sessionId: null,
      session: null,
      participants: [],
      candidates: [],
      latestResult: null,
      pendingResultRunId: null,
      selection: null,
    }),

  openSession: session => set({ sessionId: session.id, session }),
  setParticipants: participants => set({ participants }),
  setCandidates: candidates => set({ candidates }),
  setLatestResult: latestResult => set({ latestResult }),
  setSelection: selection => set({ selection }),

  applyEvent: msg => {
    const { sessionId, session } = get()
    if (sessionId == null) return
    const sameRoom = (id: number | string | undefined) => id != null && String(id) === String(sessionId)

    switch (msg.type) {
      case 'decision:participant-joined':
      case 'decision:participant-updated': {
        const p = msg.participant
        if (!p || !sameRoom(p.decision_session_id)) return
        set(s => ({ participants: upsertById(s.participants, p) }))
        return
      }
      case 'decision:candidate-added': {
        const c = msg.candidate
        if (!c || !sameRoom(c.decision_session_id)) return
        set(s => ({ candidates: upsertById(s.candidates, c) }))
        return
      }
      case 'decision:candidate-removed': {
        if (!sameRoom(msg.decisionSessionId) || msg.candidateId == null) return
        const candidateId = String(msg.candidateId)
        set(s => ({ candidates: s.candidates.filter(c => String(c.id) !== candidateId) }))
        return
      }
      case 'decision:status-updated': {
        if (!sameRoom(msg.decisionSessionId) || !msg.status || !session) return
        set({ session: { ...session, status: msg.status } })
        return
      }
      case 'decision:recommendation-ready': {
        // Content-free ping: the listening page refetches recommendations/latest.
        if (!sameRoom(msg.decisionSessionId)) return
        set({ pendingResultRunId: msg.runId ?? null })
        return
      }
      case 'decision:selected': {
        if (!sameRoom(msg.decisionSessionId) || !msg.selection) return
        set(s => ({
          selection: msg.selection ?? null,
          session: s.session ? { ...s.session, status: 'selected' } : s.session,
        }))
        return
      }
    }
  },
}))
