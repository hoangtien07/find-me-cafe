import React, { useState } from 'react'
import { MapPin, Navigation, Users } from 'lucide-react'
import { PageSpinner } from '../components/shared/Spinner'
import { useDecisionJoin } from './decisionJoin/useDecisionJoin'
import type { UpdateParticipantContextRequest } from '@trek/shared'

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
    error,
    submitting,
    handleJoin,
    handleSubmitContext,
    handleNavigate,
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

        {stage === 'context' && <ContextForm submitting={submitting} error={error} onSubmit={handleSubmitContext} />}

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
                return (
                  <li key={item.id} className="rounded-xl border border-edge p-4">
                    <div className="font-semibold">
                      #{item.rank} {snap?.name ?? `Quán ${item.candidate_id}`}
                      {!item.eligible && <span className="ml-2 text-xs text-red-500">bị loại</span>}
                    </div>
                    {item.explanation?.headline && <div className="text-sm text-accent">{item.explanation.headline}</div>}
                    {snap?.address && <div className="mt-1 text-xs text-content-faint">{snap.address}</div>}
                    {mine?.status === 'ok' && (
                      <div className="mt-1 text-xs text-content-secondary">Bạn đi khoảng {Math.round((mine.duration_seconds ?? 0) / 60)} phút</div>
                    )}
                    {snap?.lat != null && snap?.lng != null && (
                      <button
                        type="button"
                        onClick={() => handleNavigate(snap.lat!, snap.lng!)}
                        className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-accent-text"
                      >
                        <Navigation size={13} /> Điều hướng
                      </button>
                    )}
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
  onSubmit,
}: {
  submitting: boolean
  error: string | null
  onSubmit: (ctx: UpdateParticipantContextRequest) => void
}) {
  const [originLabel, setOriginLabel] = useState('')
  const [originLat, setOriginLat] = useState('')
  const [originLng, setOriginLng] = useState('')
  const [maxTravel, setMaxTravel] = useState('')
  const [budgetMin, setBudgetMin] = useState('')
  const [budgetMax, setBudgetMax] = useState('')
  const [pref1, setPref1] = useState('')
  const [pref2, setPref2] = useState('')
  const [pref3, setPref3] = useState('')
  const [vetoCategory, setVetoCategory] = useState('')

  const useMyLocation = () => {
    if (!navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(
      pos => {
        setOriginLat(pos.coords.latitude.toFixed(6))
        setOriginLng(pos.coords.longitude.toFixed(6))
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
    }
    onSubmit(ctx)
  }

  return (
    <>
      <h1 className="text-lg font-bold mb-1">Chia sẻ mong muốn của bạn</h1>
      <p className="mb-4 text-sm text-content-secondary">Giúp nhóm chọn được quán hợp cả nhóm nhất.</p>

      <label className="mb-1 block text-xs font-medium text-content-secondary">Bạn xuất phát từ đâu?</label>
      <div className="mb-3 flex gap-2">
        <input
          value={originLabel}
          onChange={e => setOriginLabel(e.target.value)}
          placeholder="Ví dụ: Bến Thành"
          className="flex-1 rounded-lg border border-edge bg-surface px-3 py-2 text-sm"
        />
        <button type="button" onClick={useMyLocation} className="inline-flex items-center gap-1 rounded-lg bg-surface-hover px-3 text-xs">
          <MapPin size={12} /> Vị trí của tôi
        </button>
      </div>
      <div className="mb-3 flex gap-2">
        <input value={originLat} onChange={e => setOriginLat(e.target.value)} placeholder="lat" className="w-1/2 rounded-lg border border-edge bg-surface px-3 py-2 text-xs" />
        <input value={originLng} onChange={e => setOriginLng(e.target.value)} placeholder="lng" className="w-1/2 rounded-lg border border-edge bg-surface px-3 py-2 text-xs" />
      </div>

      <label className="mb-1 block text-xs font-medium text-content-secondary">Đi tối đa bao nhiêu phút? (không bắt buộc)</label>
      <input value={maxTravel} onChange={e => setMaxTravel(e.target.value)} inputMode="numeric" placeholder="30" className="mb-3 w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm" />

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

      {error && <p className="mb-2 text-sm text-red-500">{error}</p>}
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
