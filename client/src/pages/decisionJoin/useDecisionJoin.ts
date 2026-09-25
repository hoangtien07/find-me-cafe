import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router'
import { decisionParticipantApi } from '../../api/decision'
import { participantSession } from '../../repo/decisionRepo'
import type {
  DecisionInvitePreview,
  DecisionVoteTally,
  RecommendationResult,
  UpdateParticipantContextRequest,
} from '@trek/shared'

export type JoinStage =
  | 'loading'      // resolving the invite token
  | 'preview'      // invite preview, asking for a name
  | 'context'      // joined — intake form (name → origin → caps)
  | 'waiting'      // submitted — poll until the host resolves
  | 'result'       // a completed run exists
  | 'invalid'

const POLL_MS = 3000

/**
 * /d/:token — the anonymous participant's whole flow (spec §8, plan Phase 12):
 * preview the invite → join with a display name → one intake form → wait →
 * the result. Participants hold no WebSocket in V1, so "waiting" polls the
 * result endpoint on a short interval. The scoped bearer token persists in
 * sessionStorage so a refresh keeps the seat.
 */
export function useDecisionJoin() {
  const { token } = useParams<{ token: string }>()
  const [stage, setStage] = useState<JoinStage>('loading')
  const [preview, setPreview] = useState<DecisionInvitePreview | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [participantToken, setParticipantToken] = useState<string | null>(participantSession.restore())
  const [participantId, setParticipantId] = useState<number | null>(null)
  const [result, setResult] = useState<RecommendationResult | null>(null)
  const [votes, setVotes] = useState<DecisionVoteTally | null>(null)
  const [myVote, setMyVote] = useState<number | string | null>(null)
  const [voting, setVoting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const viewedRef = useRef(false)

  // Self-report the first time a run actually lands on this device — the
  // funnel step between "resolved" and "navigation_opened" (M2-11).
  useEffect(() => {
    if (result == null || viewedRef.current || !participantToken) return
    viewedRef.current = true
    void decisionParticipantApi.track(participantToken, { event: 'recommendation_viewed' }).catch(() => {})
  }, [result, participantToken])

  // 1. Resolve the invite token → preview (or a restored session/result).
  useEffect(() => {
    let cancelled = false
    const existing = participantSession.restore()
    if (existing) {
      decisionParticipantApi
        .session(existing)
        .then(async view => {
          if (cancelled) return
          setParticipantToken(existing)
          setParticipantId(view.participant.id)
          try {
            const r = await decisionParticipantApi.result(existing)
            if (!cancelled) { setResult(r); setStage('result') }
          } catch {
            if (!cancelled) setStage('waiting')
          }
          try {
            const v = await decisionParticipantApi.listVotes(existing)
            if (!cancelled) setVotes(v)
          } catch { /* tally is optional chrome */ }
        })
        .catch(() => {
          if (cancelled) return
          participantSession.token = null
          setParticipantToken(null)
        })
    }
    if (!token) {
      setStage('invalid')
      return
    }
    decisionParticipantApi
      .preview(token)
      .then(({ invite }) => {
        if (cancelled || participantSession.restore()) return
        setPreview(invite)
        setStage('preview')
      })
      .catch(() => {
        if (!cancelled) setStage('invalid')
      })
    return () => {
      cancelled = true
    }
     
  }, [token])

  // 2. Poll for the run while waiting (participants hold no socket).
  useEffect(() => {
    if (stage !== 'waiting' || !participantToken) return
    pollRef.current = setInterval(async () => {
      try {
        const r = await decisionParticipantApi.result(participantToken)
        setResult(r)
        setStage('result')
        if (pollRef.current) clearInterval(pollRef.current)
        try {
          setVotes(await decisionParticipantApi.listVotes(participantToken))
        } catch { /* tally is optional chrome */ }
      } catch { /* still resolving */ }
    }, POLL_MS)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [stage, participantToken])

  // 3. Join: display name (+ inline context later); mint the scoped token.
  const handleJoin = useCallback(async () => {
    const name = displayName.trim()
    if (!token || !name) return
    setSubmitting(true)
    try {
      const { participant, participant_token } = await decisionParticipantApi.join(token, { display_name: name })
      participantSession.persist(participant_token)
      setParticipantToken(participant_token)
      setParticipantId(participant.id)
      setStage('context')
      setError(null)
    } catch {
      setError('Link đã hết hạn hoặc bị thu hồi.')
      setStage('invalid')
    } finally {
      setSubmitting(false)
    }
  }, [token, displayName])

  // 4. Submit the intake — scalars + up to 3 preferences + deal-breakers.
  const handleSubmitContext = useCallback(
    async (ctx: UpdateParticipantContextRequest) => {
      if (!participantToken) return
      setSubmitting(true)
      try {
        await decisionParticipantApi.context(participantToken, ctx)
        setStage('waiting')
        setError(null)
      } catch {
        setError('Không lưu được — thử lại nhé.')
      } finally {
        setSubmitting(false)
      }
    },
    [participantToken],
  )

  // 5. "Điều hướng" — deep-link to Google Maps and self-report the funnel step.
  const handleNavigate = useCallback(
    (lat: number, lng: number) => {
      window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`, '_blank', 'noreferrer')
      if (participantToken) {
        void decisionParticipantApi.track(participantToken, { event: 'navigation_opened' }).catch(() => {})
      }
    },
    [participantToken],
  )

  // M2-10 — the optional final vote: pick one of the recommended venues.
  // Re-casting changes the vote server-side (one row per participant).
  const handleVote = useCallback(
    async (candidateId: number | string) => {
      if (!participantToken || voting) return
      setVoting(true)
      try {
        setVotes(await decisionParticipantApi.castVote(participantToken, candidateId))
        setMyVote(candidateId)
      } catch { /* keep the previous choice */ } finally {
        setVoting(false)
      }
    },
    [participantToken, voting],
  )

  return {
    stage,
    preview,
    displayName,
    setDisplayName,
    participantId,
    result,
    votes,
    myVote,
    voting,
    error,
    submitting,
    handleJoin,
    handleSubmitContext,
    handleNavigate,
    handleVote,
  }
}
