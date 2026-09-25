import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { decisionApi } from '../../api/decision'
import { decisionRepo } from '../../repo/decisionRepo'
import { joinTrip, leaveTrip } from '../../api/websocket'
import { placeRepo } from '../../repo/placeRepo'
import { decisionPlacesRepo, type VenuePick, type VenueSuggestion } from '../../repo/decisionPlaces'
import { useDecisionStore } from '../../store/decisionStore'
import { useDecisionRealtime } from '../../hooks/useDecisionRealtime'
import type { DecisionCandidate, TrackDecisionEventRequest } from '@trek/shared'
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

  // Venue search (M2-02/03): query → debounced autocomplete → pick preview
  // (details + photo) → persist Place + candidate. The picked venue keeps its
  // provider evidence until it lands as a candidate or is dismissed.
  const [searchQuery, setSearchQuery] = useState('')
  const [suggestions, setSuggestions] = useState<VenueSuggestion[]>([])
  const [searching, setSearching] = useState(false)
  const [picked, setPicked] = useState<VenuePick | null>(null)
  const [pickLoading, setPickLoading] = useState(false)
  const [addingPick, setAddingPick] = useState(false)

  useDecisionRealtime()

  // /decision/new gives sessionId=NaN; NaN !== NaN would re-fire the effect on
  // every render, so the one-shot create is guarded by a ref.
  const createStarted = useRef(false)

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    if (creating) {
      // "New room" shortcut: create a fresh session (default title, editable
      // via PATCH later), then swap to the real room URL.
      if (createStarted.current) return
      createStarted.current = true
      // No `cancelled` gate here: StrictMode's first effect cleanup flips it
      // before the create resolves, which would strand the page on the spinner.
      decisionRepo
        .create({ title: 'Chốt quán' })
        .then(d => navigate(`/decision/${d.id}`, { replace: true }))
        .catch(() => navigate('/dashboard'))
      return () => {
        cancelled = true
      }
    }
    let joinedTripId: number | string | null = null
    decisionRepo
      .open(sessionId)
      .then(async decision => {
        if (cancelled) return
        // decision:* events ride the session's technical trip room — join it
        // like a trip page would, or no broadcast ever reaches the store.
        joinedTripId = decision.trip_id
        joinTrip(decision.trip_id)
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
      if (joinedTripId != null) leaveTrip(joinedTripId)
      reset()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Content-free recommendation-ready ping → refetch the run.
  useEffect(() => {
    if (pendingResultRunId != null) void decisionRepo.refreshLatest(sessionId)
  }, [pendingResultRunId, sessionId])

  // Debounced autocomplete. Aborts the in-flight call on every keystroke and
  // on unmount; a cleared query clears the list without a network call.
  useEffect(() => {
    const q = searchQuery.trim()
    if (q.length < 2) {
      setSuggestions([])
      setSearching(false)
      return
    }
    const ctl = new AbortController()
    const t = setTimeout(() => {
      setSearching(true)
      decisionPlacesRepo
        .search(q, ctl.signal)
        .then(res => {
          if (ctl.signal.aborted) return
          setSuggestions(res.suggestions)
        })
        .catch(() => {
          if (!ctl.signal.aborted) setSuggestions([])
        })
        .finally(() => {
          if (!ctl.signal.aborted) setSearching(false)
        })
    }, 300)
    return () => {
      clearTimeout(t)
      ctl.abort()
    }
  }, [searchQuery])

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
        await decisionApi.addCandidate(sessionId, { place_id: Number(placeId) })
        setError(null)
      } catch {
        setError('Không thêm được quán — có thể đã có trong danh sách.')
      }
    },
    [sessionId],
  )

  /** Pick a suggestion → fetch its details + photo for the preview card. */
  const handlePickSuggestion = useCallback(async (suggestion: VenueSuggestion) => {
    setPicked(null)
    setPickLoading(true)
    try {
      const pick = await decisionPlacesRepo.load(suggestion)
      setPicked(pick)
      if (!pick) setError('Không lấy được thông tin quán — thử tên khác.')
    } finally {
      setPickLoading(false)
    }
  }, [])

  const handleDismissPick = useCallback(() => setPicked(null), [])

  /** Pin the picked venue: Place + candidate with the fetched evidence. */
  const handleAddPicked = useCallback(async () => {
    if (!picked) return
    setAddingPick(true)
    try {
      const tripId = useDecisionStore.getState().session!.trip_id
      await decisionPlacesRepo.addCandidate(sessionId, Number(tripId), picked)
      setPicked(null)
      setSearchQuery('')
      setSuggestions([])
      setError(null)
    } catch {
      setError('Không thêm được quán — có thể đã có trong danh sách.')
    } finally {
      setAddingPick(false)
    }
  }, [picked, sessionId])

  /** Quick-add (dev affordance): create the Place by hand, then pin it. */
  const handleCreatePlace = useCallback(
    async (name: string, lat: number | null, lng: number | null) => {
      try {
        const { place } = await placeRepo.create(useDecisionStore.getState().session!.trip_id, {
          name,
          ...(lat != null && lng != null ? { lat, lng } : {}),
        })
        await decisionApi.addCandidate(sessionId, { place_id: place.id })
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

  // "Điều hướng" — the host's own navigation click, self-reported like the
  // participant's (M2-11). Fire-and-forget: telemetry must never block a
  // real navigation.
  const handleTrackEvent = useCallback(
    (event: TrackDecisionEventRequest['event']) => {
      void decisionApi.track(sessionId, { event }).catch(() => {})
    },
    [sessionId],
  )

  // Trip places not yet pinned are the addable picker.
  const candidatePlaceIds = new Set(candidates.map((c: DecisionCandidate) => Number(c.place_id)))
  const addablePlaces = tripPlaces.filter(p => !candidatePlaceIds.has(Number(p.id)))

  // Provider ids already pinned — a pick carrying one of them is a duplicate
  // before it reaches the server (which dedupes again on the same rule).
  const candidateProviderIds = new Set(
    candidates
      .map(c => c.snapshot?.google_place_id ?? c.snapshot?.osm_id ?? c.snapshot?.amap_poi_id)
      .filter((x): x is string => Boolean(x)),
  )

  // True when the previewed pick is already pinned under a provider id — the
  // add button disables itself instead of bouncing off the server's dedup.
  const pickedIsDuplicate = picked != null && (() => {
    const id = decisionPlacesRepo.providerIdOf(picked)
    return id != null && candidateProviderIds.has(id)
  })()

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
    searchQuery,
    suggestions,
    searching,
    picked,
    pickLoading,
    addingPick,
    pickedIsDuplicate,
    handleInvite,
    handleAddCandidate,
    handleSearchChange: setSearchQuery,
    handlePickSuggestion,
    handleDismissPick,
    handleAddPicked,
    handleCreatePlace,
    handleRemoveCandidate,
    handleResolve,
    handleSelect,
    handleFeedback,
    handleTrackEvent,
  }
}
