import { decisionApi } from '../api/decision'
import { useDecisionStore } from '../store/decisionStore'
import type {
  CreateDecisionRequest,
  DecisionCandidate,
  DecisionParticipant,
  DecisionParticipantRosterEntry,
  DecisionSelection,
  DecisionSession,
  DecisionVoteTally,
  RecommendationResult,
} from '@trek/shared'

/**
 * Data layer for the decision room. Unlike the trip repos it never touches
 * Dexie: a decision room is anonymous-participant state with no offline-first
 * contract, so the Zustand decisionStore is the single client copy and the
 * `decision:*` WS events keep it fresh (useDecisionRealtime).
 *
 * M2-12 adds one narrow exception for the alpha: the host's last-seen room
 * snapshot is mirrored to localStorage so a reload while offline still shows
 * the latest result/selection — read-only cache, never a write path.
 */

const cacheKey = (id: number | string) => `decision_room_${id}`

interface CachedRoom {
  decision: DecisionSession
  participants: (DecisionParticipant | DecisionParticipantRosterEntry)[]
  candidates: DecisionCandidate[]
  latestResult: RecommendationResult | null
  selection: DecisionSelection | null
  votes: DecisionVoteTally | null
  cached_at: string
}

const cacheRoom = (id: number | string) => {
  try {
    const s = useDecisionStore.getState()
    if (String(s.sessionId) !== String(id) || !s.session) return
    const room: CachedRoom = {
      decision: s.session,
      participants: s.participants,
      candidates: s.candidates,
      latestResult: s.latestResult,
      selection: s.selection,
      votes: s.votes,
      cached_at: new Date().toISOString(),
    }
    localStorage.setItem(cacheKey(id), JSON.stringify(room))
  } catch { /* private mode / quota — caching is best-effort */ }
}

const readCachedRoom = (id: number | string): CachedRoom | null => {
  try {
    const raw = localStorage.getItem(cacheKey(id))
    return raw ? (JSON.parse(raw) as CachedRoom) : null
  } catch {
    return null
  }
}

/** One consistent snapshot of the room, tagged with the eventSeq it started at. */
const fetchRoom = async (id: number | string) => {
  const seq = useDecisionStore.getState().eventSeq
  const res = await decisionApi.get(id)
  const candidates = (await decisionApi.listCandidates(id)).candidates
  let latestResult: RecommendationResult | null = null
  try {
    latestResult = await decisionApi.latest(id)
  } catch { /* no completed run yet */ }
  const votes = await decisionApi.listVotes(id)
  return { seq, ...res, candidates, latestResult, votes }
}

export const decisionRepo = {
  /**
   * Load a room the caller hosts: session + roster + candidates + last run.
   * A decision:* event can land between the REST calls and the store writes —
   * e.g. a participant joins while a reconnect re-pull is in flight. eventSeq
   * marks live updates: if it moved during the fetch that snapshot is already
   * stale, so pull once more. The freshest fetch wins either way — a coherent
   * snapshot beats a half-populated store.
   */
  async open(id: number | string) {
    let room
    try {
      room = await fetchRoom(id)
      if (useDecisionStore.getState().eventSeq !== room.seq) room = await fetchRoom(id)
    } catch (err) {
      // M2-12 — offline alpha: restore the host's last-seen snapshot instead
      // of landing on an empty room. Only falls back when a cache exists.
      const cached = readCachedRoom(id)
      if (!cached) throw err
      room = { seq: useDecisionStore.getState().eventSeq, ...cached }
    }
    const s = useDecisionStore.getState()
    s.openSession(room.decision)
    s.setParticipants(room.participants)
    s.setCandidates(room.candidates)
    s.setLatestResult(room.latestResult)
    s.setSelection(room.selection)
    s.setVotes(room.votes)
    s.setFromCache('cached_at' in room && room.cached_at != null)
    if (!s.staleFromCache) cacheRoom(id)
    return room.decision
  },

  async create(data: CreateDecisionRequest) {
    const { decision } = await decisionApi.create(data)
    useDecisionStore.getState().openSession(decision)
    return decision
  },

  /** Mint the anonymous join link; the token is returned exactly once. */
  async inviteLink(id: number | string): Promise<string> {
    const { invite } = await decisionApi.createInvite(id, {})
    return `${location.origin}/d/${invite.token}`
  },

  async resolve(id: number | string) {
    const result = await decisionApi.resolve(id)
    useDecisionStore.getState().setLatestResult(result)
    cacheRoom(id)
    return result
  },

  /** Refetch the latest run (called when decision:recommendation-ready pings). */
  async refreshLatest(id: number | string) {
    try {
      useDecisionStore.getState().setLatestResult(await decisionApi.latest(id))
    } catch {
      useDecisionStore.getState().setLatestResult(null)
    }
    cacheRoom(id)
  },

  async select(id: number | string, candidateId: number | string) {
    const { selection } = await decisionApi.select(id, candidateId)
    useDecisionStore.getState().setSelection(selection)
    cacheRoom(id)
    return selection
  },
}

/**
 * The scoped participant token — persisted in sessionStorage so a refresh
 * keeps the participant's seat, but it never enters TREK auth storage.
 */
export const participantSession = {
  token: null as string | null,

  persist(token: string) {
    this.token = token
    try {
      sessionStorage.setItem('decision_participant_token', token)
    } catch { /* private mode — keep it in memory */ }
  },

  restore(): string | null {
    if (this.token) return this.token
    try {
      return sessionStorage.getItem('decision_participant_token')
    } catch {
      return null
    }
  },
}
