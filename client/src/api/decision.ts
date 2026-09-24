import { apiClient } from './client'
import type {
  CreateDecisionRequest,
  CreateDecisionFeedbackRequest,
  CreateDecisionInviteRequest,
  DecisionCandidate,
  DecisionInvitePreview,
  DecisionInviteWithToken,
  DecisionParticipant,
  DecisionParticipantRosterEntry,
  DecisionParticipantSessionResponse,
  DecisionSelection,
  DecisionSession,
  JoinDecisionRequest,
  RecommendationResult,
  TrackDecisionEventRequest,
  UpdateDecisionRequest,
  UpdateParticipantContextRequest,
} from '@trek/shared'

/**
 * Decision room API ("chốt quán") — wraps the spec §19 surface.
 *
 * Two credentials, two namespaces:
 *  - decisionApi: host routes on the TREK session cookie.
 *  - decisionParticipantApi: the anonymous participant's scoped bearer token
 *    (minted at join, never a TREK JWT — spec §8). Participants hold no
 *    WebSocket in V1, so result fetches here are the client's polling loop.
 */

const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } })

export const decisionApi = {
  create: (data: CreateDecisionRequest) =>
    apiClient.post<{ decision: DecisionSession }>('/decisions', data).then(r => r.data),
  list: () =>
    apiClient.get<{ decisions: DecisionSession[] }>('/decisions').then(r => r.data),
  get: (id: number | string) =>
    apiClient
      .get<{ decision: DecisionSession; participants: DecisionParticipantRosterEntry[] }>(`/decisions/${id}`)
      .then(r => r.data),
  update: (id: number | string, data: UpdateDecisionRequest) =>
    apiClient.patch<{ decision: DecisionSession }>(`/decisions/${id}`, data).then(r => r.data),
  createInvite: (id: number | string, data: CreateDecisionInviteRequest = {}) =>
    apiClient.post<{ invite: DecisionInviteWithToken }>(`/decisions/${id}/invites`, data).then(r => r.data),
  listCandidates: (id: number | string) =>
    apiClient.get<{ candidates: DecisionCandidate[] }>(`/decisions/${id}/candidates`).then(r => r.data),
  addCandidate: (id: number | string, placeId: number | string) =>
    apiClient.post<{ candidate: DecisionCandidate }>(`/decisions/${id}/candidates`, { place_id: placeId }).then(r => r.data),
  removeCandidate: (id: number | string, candidateId: number | string) =>
    apiClient.delete<{ ok: true }>(`/decisions/${id}/candidates/${candidateId}`).then(r => r.data),
  resolve: (id: number | string) =>
    apiClient.post<RecommendationResult>(`/decisions/${id}/resolve`, {}).then(r => r.data),
  latest: (id: number | string) =>
    apiClient.get<RecommendationResult>(`/decisions/${id}/recommendations/latest`).then(r => r.data),
  select: (id: number | string, candidateId: number | string) =>
    apiClient.post<{ selection: DecisionSelection }>(`/decisions/${id}/select`, { candidate_id: candidateId }).then(r => r.data),
  feedback: (id: number | string, data: CreateDecisionFeedbackRequest) =>
    apiClient.post<{ feedback: unknown }>(`/decisions/${id}/feedback`, data).then(r => r.data),
}

export const decisionParticipantApi = {
  preview: (token: string) =>
    apiClient.get<{ invite: DecisionInvitePreview }>(`/decision-invites/${token}`).then(r => r.data),
  join: (token: string, data: JoinDecisionRequest) =>
    apiClient
      .post<{ participant: DecisionParticipant; participant_token: string }>(`/decision-invites/${token}/join`, data)
      .then(r => r.data),
  session: (token: string) =>
    apiClient.get<DecisionParticipantSessionResponse>('/decision-participant/session', bearer(token)).then(r => r.data),
  context: (token: string, data: UpdateParticipantContextRequest) =>
    apiClient.put<{ participant: DecisionParticipant }>('/decision-participant/context', data, bearer(token)).then(r => r.data),
  candidates: (token: string) =>
    apiClient.get<{ candidates: DecisionCandidate[] }>('/decision-participant/candidates', bearer(token)).then(r => r.data),
  result: (token: string) =>
    apiClient.get<RecommendationResult>('/decision-participant/result', bearer(token)).then(r => r.data),
  track: (token: string, data: TrackDecisionEventRequest) =>
    apiClient.post<{ ok: boolean }>('/decision-participant/telemetry', data, bearer(token)).then(r => r.data),
}
