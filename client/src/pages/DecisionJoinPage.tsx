import React, { useEffect, useState } from 'react'
import { MapPin, Navigation, Search, Users, Vote } from 'lucide-react'
import { PageSpinner } from '../components/shared/Spinner'
import { useDecisionJoin } from './decisionJoin/useDecisionJoin'
import { decisionParticipantApi } from '../api/decision'
import type { DecisionOriginSuggestion, DecisionTravelMode, UpdateParticipantContextRequest } from '@trek/shared'

/** VN labels for the intake chips and the result's per-participant ride mode. */
const MODE_LABELS: Record<DecisionTravelMode, string> = {
  walking: 'Đi bộ',
  cycling: 'Xe máy',
  driving: 'Ô tô',
  transit: 'Xe buýt',
}

/**
 * /d/:token — the anonymous participant flow (invite preview → join → intake
 * → wait → result). Intentionally outside TREK's dashboard chrome: no nav, no
 * account UI, the scoped bearer token is the only credential (spec §8/§12).
 */
export default function DecisionJoinPage() {
  const {
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
    participantToken,
    handleJoin,
    handleSubmitContext,
    handleNavigate,
    handleVote,
  } = useDecisionJoin()

  return (
    <div className="min-h-screen bg-surface text-content flex items-start justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-edge bg-surface-card p-6">
        {stage === 'loading' && <PageSpinner wrapperClassName="flex justify-center py-8" />}

        {stage === 'invalid' && (
          <>
            <h1 className="text-lg font-bold mb-2">Link không còn dùng được</h1>
            <p className="text-sm text-content-secondary">
              {error ?? 'Link mời đã hết hạn, bị thu hồi, hoặc buổi chốt quán đã bắt đầu.'}
            </p>
          </>
        )}

        {stage === 'preview' && preview && (
          <>
            <div className="mb-4 flex justify-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-hover">
                <Users size={22} className="text-accent" />
              </div>
            </div>
            <h1 className="text-lg font-bold text-center">{preview.title}</h1>
            <p className="mt-1 mb-5 text-center text-sm text-content-secondary">
              {preview.participant_count} người đã tham gia
              {preview.scheduled_at ? ` · ${new Date(preview.scheduled_at).toLocaleString('vi-VN')}` : ''}
            </p>
            <input
              autoFocus
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleJoin()}
              placeholder="Tên của bạn (ví dụ: An)"
              className="mb-3 w-full rounded-lg border border-edge bg-surface px-3 py-2.5 text-sm"
            />
            <button
              type="button"
              disabled={submitting || !displayName.trim()}
              onClick={handleJoin}
              className="w-full rounded-xl bg-accent px-4 py-2.5 font-semibold text-accent-text disabled:opacity-50"
            >
              Tham gia
            </button>
          </>
        )}

        {stage === 'context' && <ContextForm submitting={submitting} error={error} participantToken={participantToken} onSubmit={handleSubmitContext} />}

        {stage === 'waiting' && (
          <div className="py-6 text-center">
            <PageSpinner wrapperClassName="flex justify-center pb-4" />
            <h1 className="font-semibold">Xong rồi!</h1>
            <p className="mt-1 text-sm text-content-secondary">Chờ host bấm “Tìm quán phù hợp nhất” — trang tự cập nhật.</p>
          </div>
        )}

        {stage === 'result' && result && (
          <>
            <h1 className="text-lg font-bold mb-1">Nhóm đã có gợi ý</h1>
            <p className="mb-4 text-sm text-content-secondary">Top quán được chấm cho cả nhóm:</p>
            <ol className="space-y-3">
              {result.items.slice(0, 3).map(item => {
                const snap = item.candidate.snapshot
                const mine = item.explanation?.travel_times.find(
                  tt => participantId != null && String(tt.participant_id) === String(participantId),
                )
                const tally = votes?.votes.find(v => String(v.candidate_id) === String(item.candidate_id))
                const voted = myVote != null && String(myVote) === String(item.candidate_id)
                return (
                  <li key={item.id} className="rounded-xl border border-edge p-4">
                    <div className="font-semibold">
                      #{item.rank} {snap?.name ?? `Quán ${item.candidate_id}`}
                      {!item.eligible && <span className="ml-2 text-xs text-red-500">bị loại</span>}
                    </div>
                    {item.explanation?.headline && <div className="text-sm text-accent">{item.explanation.headline}</div>}
                    {snap?.address && <div className="mt-1 text-xs text-content-faint">{snap.address}</div>}
                    {mine?.status === 'ok' && (
                      <div className="mt-1 text-xs text-content-secondary">
                        Bạn đi khoảng {Math.round((mine.duration_seconds ?? 0) / 60)} phút
                        {mine.travel_mode ? ` · ${MODE_LABELS[mine.travel_mode]}` : ''}
                      </div>
                    )}
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {snap?.lat != null && snap?.lng != null && (
                        <button
                          type="button"
                          onClick={() => handleNavigate(snap.lat!, snap.lng!)}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-accent-text"
                        >
                          <Navigation size={13} /> Điều hướng
                        </button>
                      )}
                      {item.eligible && (
                        <button
                          type="button"
                          disabled={voting}
                          aria-pressed={voted}
                          aria-label={`Bình chọn ${snap?.name ?? 'quán này'}`}
                          onClick={() => handleVote(item.candidate_id)}
                          className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold ${voted ? 'bg-emerald-600 text-white' : 'bg-surface-hover text-content'}`}
                        >
                          {voted ? '✓ Đã chọn' : 'Bình chọn'}
                        </button>
                      )}
                      {tally && (
                        <span aria-live="polite" className="inline-flex items-center gap-1 text-xs text-content-faint">
                          <Vote size={11} aria-hidden /> {tally.count} phiếu{tally.voter_names.length > 0 ? ` · ${tally.voter_names.join(', ')}` : ''}
                        </span>
                      )}
                    </div>
                  </li>
                )
              })}
            </ol>
          </>
        )}
      </div>
    </div>
  )
}

/** The one-form intake: origin, travel cap, budget, up to 3 prefs, deal-breakers. */
function ContextForm({
  submitting,
  error,
  participantToken,
  onSubmit,
}: {
  submitting: boolean
  error: string | null
  participantToken: string | null
  onSubmit: (ctx: UpdateParticipantContextRequest) => void
}) {
  const [originLabel, setOriginLabel] = useState('')
  const [originLat, setOriginLat] = useState('')
  const [originLng, setOriginLng] = useState('')
  const [originPicked, setOriginPicked] = useState(false)
  const [originSuggestions, setOriginSuggestions] = useState<DecisionOriginSuggestion[]>([])
  const [originSearching, setOriginSearching] = useState(false)
  const [maxTravel, setMaxTravel] = useState('')
  const [budgetMin, setBudgetMin] = useState('')
  const [budgetMax, setBudgetMax] = useState('')
  const [pref1, setPref1] = useState('')
  const [pref2, setPref2] = useState('')
  const [pref3, setPref3] = useState('')
  const [vetoCategory, setVetoCategory] = useState('')
  const [travelMode, setTravelMode] = useState<DecisionTravelMode | null>(null)

  // Debounced forward-geocode for the "from" box — aborts the in-flight call
  // on every keystroke; a picked suggestion or the GPS button freezes coords.
  useEffect(() => {
    const q = originLabel.trim()
    if (originPicked || q.length < 2 || !participantToken) {
      setOriginSuggestions([])
      setOriginSearching(false)
      return
    }
    const ctl = new AbortController()
    const t = setTimeout(() => {
      setOriginSearching(true)
      decisionParticipantApi
        .originSearch(participantToken, q, ctl.signal)
        .then(res => {
          if (!ctl.signal.aborted) setOriginSuggestions(res.suggestions)
        })
        .catch(() => {
          if (!ctl.signal.aborted) setOriginSuggestions([])
        })
        .finally(() => {
          if (!ctl.signal.aborted) setOriginSearching(false)
        })
    }, 350)
    return () => {
      clearTimeout(t)
      ctl.abort()
    }
  }, [originLabel, originPicked, participantToken])

  const pickOrigin = (s: DecisionOriginSuggestion) => {
    setOriginLabel(s.name + (s.address ? ` · ${s.address}` : ''))
    setOriginLat(s.lat.toFixed(6))
    setOriginLng(s.lng.toFixed(6))
    setOriginPicked(true)
    setOriginSuggestions([])
  }

  const clearOrigin = () => {
    setOriginPicked(false)
    setOriginLat('')
    setOriginLng('')
    setOriginSuggestions([])
  }

  const useMyLocation = () => {
    if (!navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(
      pos => {
        setOriginLat(pos.coords.latitude.toFixed(6))
        setOriginLng(pos.coords.longitude.toFixed(6))
        setOriginPicked(true)
        if (!originLabel) setOriginLabel('Vị trí của tôi')
      },
      () => {},
      { timeout: 8000 },
    )
  }

  const submit = () => {
    const prefs = [pref1, pref2, pref3]
      .map(v => v.trim())
      .filter(Boolean)
      .map(v => ({ key: 'like', value: v }))
    const ctx: UpdateParticipantContextRequest = {
      ...(originLat.trim() && originLng.trim()
        ? { origin: { lat: Number(originLat), lng: Number(originLng), label: originLabel.trim() || undefined } }
        : {}),
      ...(maxTravel.trim() ? { max_travel_minutes: Number(maxTravel) } : {}),
      ...(budgetMin.trim() ? { budget_min: Number(budgetMin) } : {}),
      ...(budgetMax.trim() ? { budget_max: Number(budgetMax) } : {}),
      ...(prefs.length ? { preferences: prefs } : {}),
      ...(vetoCategory.trim()
        ? { deal_breakers: [{ type: 'veto_category' as const, value: { category: vetoCategory.trim() } }] }
        : {}),
      ...(travelMode ? { travel_mode: travelMode } : {}),
    }
    onSubmit(ctx)
  }

  return (
    <>
      <h1 className="text-lg font-bold mb-1">Chia sẻ mong muốn của bạn</h1>
      <p className="mb-4 text-sm text-content-secondary">Giúp nhóm chọn được quán hợp cả nhóm nhất.</p>

      <label className="mb-1 block text-xs font-medium text-content-secondary">Bạn xuất phát từ đâu?</label>
      <div className="mb-3 flex gap-2">
        <div className="relative flex-1">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-content-faint" />
          <input
            value={originLabel}
            onChange={e => {
              setOriginLabel(e.target.value)
              if (originPicked) clearOrigin()
            }}
            placeholder="Ví dụ: Bến Thành"
            className="w-full rounded-lg border border-edge bg-surface pl-9 pr-3 py-2 text-sm"
          />
          {originSearching && <p className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-content-faint">…</p>}
          {originSuggestions.length > 0 && (
            <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-edge bg-surface-card shadow-lg">
              {originSuggestions.map((s, i) => (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => pickOrigin(s)}
                    className="block w-full px-3 py-2 text-left text-sm hover:bg-surface-hover"
                  >
                    <span className="block font-medium">{s.name}</span>
                    {s.address && <span className="block text-xs text-content-faint">{s.address}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button type="button" onClick={useMyLocation} className="inline-flex items-center gap-1 rounded-lg bg-surface-hover px-3 text-xs">
          <MapPin size={12} /> Vị trí của tôi
        </button>
      </div>
      {originPicked && originLat && (
        <p className="mb-3 -mt-1 text-xs text-content-faint">Đã chốt điểm xuất phát — gõ lại để đổi.</p>
      )}

      <label className="mb-1 block text-xs font-medium text-content-secondary">Đi tối đa bao nhiêu phút? (không bắt buộc)</label>
      <input value={maxTravel} onChange={e => setMaxTravel(e.target.value)} inputMode="numeric" placeholder="30" className="mb-3 w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm" />

      <label className="mb-1 block text-xs font-medium text-content-secondary">Bạn đi bằng gì? (mặc định theo nhóm)</label>
      <div className="mb-3 flex flex-wrap gap-2">
        {(Object.entries(MODE_LABELS) as [DecisionTravelMode, string][]).map(([mode, label]) => (
          <button
            key={mode}
            type="button"
            onClick={() => setTravelMode(m => (m === mode ? null : mode))}
            className={`rounded-full border px-3 py-1.5 text-xs font-medium ${
              travelMode === mode ? 'border-accent bg-accent text-accent-text' : 'border-edge bg-surface text-content-secondary'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <label className="mb-1 block text-xs font-medium text-content-secondary">Ngân sách mỗi người (₫, không bắt buộc)</label>
      <div className="mb-3 flex gap-2">
        <input value={budgetMin} onChange={e => setBudgetMin(e.target.value)} inputMode="numeric" placeholder="Từ" className="w-1/2 rounded-lg border border-edge bg-surface px-3 py-2 text-sm" />
        <input value={budgetMax} onChange={e => setBudgetMax(e.target.value)} inputMode="numeric" placeholder="Đến" className="w-1/2 rounded-lg border border-edge bg-surface px-3 py-2 text-sm" />
      </div>

      <label className="mb-1 block text-xs font-medium text-content-secondary">Bạn thích gì? (tối đa 3, không bắt buộc)</label>
      {[pref1, pref2, pref3].map((v, i) => (
        <input
          key={i}
          value={v}
          onChange={e => [setPref1, setPref2, setPref3][i]!(e.target.value)}
          placeholder={['yên tĩnh', 'view đẹp', 'wifi mạnh'][i]}
          className="mb-2 w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm"
        />
      ))}

      <label className="mb-1 mt-3 block text-xs font-medium text-content-secondary">Tuyệt đối không đi loại quán nào? (không bắt buộc)</label>
      <input value={vetoCategory} onChange={e => setVetoCategory(e.target.value)} placeholder="ví dụ: bar" className="mb-4 w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm" />

      {error && <p role="alert" className="mb-2 text-sm text-red-500">{error}</p>}
      <button
        type="button"
        disabled={submitting}
        onClick={submit}
        className="w-full rounded-xl bg-accent px-4 py-2.5 font-semibold text-accent-text disabled:opacity-50"
      >
        Xong — chờ kết quả
      </button>
    </>
  )
}
