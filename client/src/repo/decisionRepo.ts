import { decisionApi } from '../api/decision'
import { useDecisionStore } from '../store/decisionStore'
import type { CreateDecisionRequest, RecommendationResult } from '@trek/shared'

/**
 * Data layer for the decision room. Unlike the trip repos it never touches
 * Dexie: a decision room is anonymous-participant state with no offline-first
 * contract, so the Zustand decisionStore is the single client copy and the
 * `decision:*` WS events keep it fresh (useDecisionRealtime).
 */

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
    let room = await fetchRoom(id)
    if (useDecisionStore.getState().eventSeq !== room.seq) room = await fetchRoom(id)
    const s = useDecisionStore.getState()
    s.openSession(room.decision)
    s.setParticipants(room.participants)
    s.setCandidates(room.candidates)
    s.setLatestResult(room.latestResult)
    s.setSelection(room.selection)
    s.setVotes(room.votes)
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
    return result
  },

  /** Refetch the latest run (called when decision:recommendation-ready pings). */
  async refreshLatest(id: number | string) {
    try {
      useDecisionStore.getState().setLatestResult(await decisionApi.latest(id))
    } catch {
      useDecisionStore.getState().setLatestResult(null)
    }
  },

  async select(id: number | string, candidateId: number | string) {
    const { selection } = await decisionApi.select(id, candidateId)
    useDecisionStore.getState().setSelection(selection)
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
