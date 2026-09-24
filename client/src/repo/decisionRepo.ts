import { decisionApi } from '../api/decision'
import { useDecisionStore } from '../store/decisionStore'
import type { CreateDecisionRequest } from '@trek/shared'

/**
 * Data layer for the decision room. Unlike the trip repos it never touches
 * Dexie: a decision room is anonymous-participant state with no offline-first
 * contract, so the Zustand decisionStore is the single client copy and the
 * `decision:*` WS events keep it fresh (useDecisionRealtime).
 */
export const decisionRepo = {
  /** Load a room the caller hosts: session + roster + candidates + last run. */
  async open(id: number | string) {
    const { decision, participants } = await decisionApi.get(id)
    const s = useDecisionStore.getState()
    s.openSession(decision)
    s.setParticipants(participants)
    s.setCandidates((await decisionApi.listCandidates(id)).candidates)
    try {
      s.setLatestResult(await decisionApi.latest(id))
    } catch {
      s.setLatestResult(null)
    }
    return decision
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
