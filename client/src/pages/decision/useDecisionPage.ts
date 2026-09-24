import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { decisionApi } from '../../api/decision'
import { decisionRepo } from '../../repo/decisionRepo'
import { placeRepo } from '../../repo/placeRepo'
import { useDecisionStore } from '../../store/decisionStore'
import { useDecisionRealtime } from '../../hooks/useDecisionRealtime'
import type { DecisionCandidate } from '@trek/shared'
import type { Place } from '../../types'

/**
 * Host page hook — owns the room load, the realtime mount and every handler.
 * DecisionPage stays a pure wiring container (see PATTERN.md).
 */
export function useDecisionPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const sessionId = Number(id)
  const creating = id === 'new'

  const session = useDecisionStore(s => s.session)
  const participants = useDecisionStore(s => s.participants)
  const candidates = useDecisionStore(s => s.candidates)
  const latestResult = useDecisionStore(s => s.latestResult)
  const pendingResultRunId = useDecisionStore(s => s.pendingResultRunId)
  const selection = useDecisionStore(s => s.selection)
  const reset = useDecisionStore(s => s.reset)

  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [inviteLink, setInviteLink] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const [tripPlaces, setTripPlaces] = useState<Place[]>([])

  useDecisionRealtime()

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    if (creating) {
      // "New room" shortcut: create a fresh session (default title, editable
      // via PATCH later), then swap to the real room URL.
      decisionRepo
        .create({ title: 'Chốt quán' })
        .then(d => !cancelled && navigate(`/decision/${d.id}`, { replace: true }))
        .catch(() => !cancelled && navigate('/dashboard'))
      return () => {
        cancelled = true
      }
    }
    decisionRepo
      .open(sessionId)
      .then(async decision => {
        if (cancelled) return
        setTripPlaces((await placeRepo.list(decision.trip_id)).places)
      })
      .catch(() => {
        if (!cancelled) navigate('/dashboard')
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
      reset()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Content-free recommendation-ready ping → refetch the run.
  useEffect(() => {
    if (pendingResultRunId != null) void decisionRepo.refreshLatest(sessionId)
  }, [pendingResultRunId, sessionId])

  const handleInvite = useCallback(async () => {
    const link = await decisionRepo.inviteLink(sessionId)
    setInviteLink(link)
    try {
      await navigator.clipboard.writeText(link)
    } catch { /* clipboard unavailable — the link stays visible to copy */ }
  }, [sessionId])

  const handleAddCandidate = useCallback(
    async (placeId: number | string) => {
      try {
        await decisionApi.addCandidate(sessionId, placeId)
        setError(null)
      } catch {
        setError('Không thêm được quán — có thể đã có trong danh sách.')
      }
    },
    [sessionId],
  )

  /** Quick-add: create the Place on the technical trip, then pin it. */
  const handleCreatePlace = useCallback(
    async (name: string, lat: number | null, lng: number | null) => {
      try {
        const { place } = await placeRepo.create(useDecisionStore.getState().session!.trip_id, {
          name,
          ...(lat != null && lng != null ? { lat, lng } : {}),
        })
        await decisionApi.addCandidate(sessionId, place.id)
        setTripPlaces(await placeRepo.list(useDecisionStore.getState().session!.trip_id).then(r => r.places))
        setError(null)
      } catch {
        setError('Không tạo được quán mới.')
      }
    },
    [sessionId],
  )

  const handleRemoveCandidate = useCallback(
    async (candidateId: number | string) => {
      try {
        await decisionApi.removeCandidate(sessionId, candidateId)
        setError(null)
      } catch {
        setError('Không xoá được quán.')
      }
    },
    [sessionId],
  )

  const handleResolve = useCallback(async () => {
    setResolving(true)
    try {
      await decisionRepo.resolve(sessionId)
      setError(null)
    } catch {
      setError('Chưa đủ dữ liệu để chấm điểm — cần ít nhất 1 quán và 1 người tham gia.')
    } finally {
      setResolving(false)
    }
  }, [sessionId])

  const handleSelect = useCallback(
    async (candidateId: number | string) => {
      try {
        await decisionRepo.select(sessionId, candidateId)
        setError(null)
      } catch {
        setError('Không chốt được quán.')
      }
    },
    [sessionId],
  )

  const handleFeedback = useCallback(
    async (candidateId: number, fitScore: number, wouldChooseAgain: boolean, regretReason: string | null) => {
      await decisionApi.feedback(sessionId, {
        candidate_id: candidateId,
        fit_score: fitScore,
        would_choose_again: wouldChooseAgain,
        regret_reason: regretReason,
      })
    },
    [sessionId],
  )

  // Trip places not yet pinned are the addable picker.
  const candidatePlaceIds = new Set(candidates.map((c: DecisionCandidate) => Number(c.place_id)))
  const addablePlaces = tripPlaces.filter(p => !candidatePlaceIds.has(Number(p.id)))

  return {
    sessionId,
    session,
    participants,
    candidates,
    latestResult,
    selection,
    isLoading,
    error,
    inviteLink,
    resolving,
    addablePlaces,
    handleInvite,
    handleAddCandidate,
    handleCreatePlace,
    handleRemoveCandidate,
    handleResolve,
    handleSelect,
    handleFeedback,
  }
}
