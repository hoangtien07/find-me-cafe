import React, { useState } from 'react'
import { PageSpinner } from '../components/shared/Spinner'
import { Copy, ExternalLink, MapPin, Navigation, Phone, Search, Star, UserCheck, Users, X } from 'lucide-react'
import { useDecisionPage } from './decision/useDecisionPage'
import { MapViewAuto } from '../components/Map/MapViewAuto'
import type { Poi } from '../components/Map/poiCategories'
import type { VenuePick, VenueSuggestion } from '../repo/decisionPlaces'
import type {
  DecisionCandidate,
  DecisionParticipant,
  DecisionParticipantRosterEntry,
  RecommendationResult,
  UpsertVenueContextRequest,
} from '@trek/shared'

type RosterEntry = DecisionParticipant | DecisionParticipantRosterEntry

const STATUS_LABEL: Record<string, string> = {
  collecting: 'Đang thu thập',
  ready: 'Sẵn sàng',
  resolving: 'Đang chấm điểm…',
  resolved: 'Đã có gợi ý',
  selected: 'Đã chốt',
  closed: 'Đã đóng',
  canceled: 'Đã huỷ',
}

const fmtMin = (seconds: number | null | undefined): string =>
  seconds == null ? '—' : `${Math.round(seconds / 60)} phút`

/**
 * /decision/:id — the host's decision room ("chốt quán"): roster, candidates,
 * resolver run and the Top-3 picker. Wiring container only — every handler and
 * effect lives in useDecisionPage (PATTERN.md). UI copy is Vietnamese: the
 * product targets VN groups, and i18n keys land with the polish pass.
 */
export default function DecisionPage() {
  const {
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
    handleSearchChange,
    handlePickSuggestion,
    handleDismissPick,
    handleAddPicked,
    handleCreatePlace,
    handleRemoveCandidate,
    handleResolve,
    handleSelect,
    handleFeedback,
    handleTrackEvent,
    handleVenueContext,
  } = useDecisionPage()

  if (isLoading || !session) {
    return <PageSpinner wrapperClassName="min-h-screen flex items-center justify-center bg-surface" />
  }

  const resolvable = ['collecting', 'ready', 'resolved', 'selected'].includes(session.status)
  const topItems = latestResult?.items ?? []
  const selectedId = selection?.candidate_id ?? null

  return (
    <div className="min-h-screen bg-surface text-content">
      <div className="max-w-3xl mx-auto px-4 py-8">
        <header className="mb-6">
          <h1 className="text-2xl font-bold">{session.title ?? 'Chốt quán'}</h1>
          <div className="flex items-center gap-3 mt-2">
            <span className="text-sm text-content-secondary">{STATUS_LABEL[session.status] ?? session.status}</span>
            <button
              type="button"
              onClick={handleInvite}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-accent-text"
            >
              <Copy size={14} /> Link mời nhóm
            </button>
          </div>
          {inviteLink && (
            <p className="mt-2 break-all rounded-lg border border-edge bg-surface-card px-3 py-2 text-xs text-content-secondary">
              {inviteLink} — đã copy, gửi cho nhóm qua bất kỳ kênh nào.
            </p>
          )}
        </header>

        <Roster participants={participants} />
        <CandidateSection
          candidates={candidates}
          addablePlaces={addablePlaces}
          searchQuery={searchQuery}
          suggestions={suggestions}
          searching={searching}
          picked={picked}
          pickLoading={pickLoading}
          addingPick={addingPick}
          pickedIsDuplicate={pickedIsDuplicate}
          onSearchChange={handleSearchChange}
          onPickSuggestion={handlePickSuggestion}
          onDismissPick={handleDismissPick}
          onAddPicked={handleAddPicked}
          onAdd={handleAddCandidate}
          onCreate={handleCreatePlace}
          onRemove={handleRemoveCandidate}
          onSaveContext={handleVenueContext}
        />

        {error && <p className="my-3 text-sm text-red-500">{error}</p>}

        {resolvable && topItems.length === 0 && (
          <button
            type="button"
            disabled={resolving || candidates.length === 0 || participants.length === 0}
            onClick={handleResolve}
            className="my-4 w-full rounded-xl bg-accent px-4 py-3 font-semibold text-accent-text disabled:opacity-50"
          >
            {resolving ? 'Đang chấm điểm…' : 'Tìm quán phù hợp nhất'}
          </button>
        )}

        {topItems.length > 0 && (
          <RecommendationList
            result={latestResult!}
            selectedId={selectedId}
            sessionStatus={session.status}
            onSelect={handleSelect}
            onFeedback={handleFeedback}
            onNavigate={() => handleTrackEvent('navigation_opened')}
          />
        )}

        {topItems.length > 0 && (
          <DecisionMap
            items={topItems}
            selectedId={selectedId}
            participants={participants}
            tripId={session.trip_id}
          />
        )}
      </div>
    </div>
  )
}

function Roster({ participants }: { participants: RosterEntry[] }) {
  return (
    <section className="mb-6 rounded-xl border border-edge bg-surface-card p-4">
      <h2 className="mb-3 flex items-center gap-2 font-semibold">
        <Users size={16} className="text-accent" /> Người tham gia ({participants.length})
      </h2>
      {participants.length === 0 ? (
        <p className="text-sm text-content-faint">Chưa có ai — gửi link mời cho nhóm.</p>
      ) : (
        <ul className="space-y-1.5">
          {participants.map(p => (
            <li key={p.id} className="flex items-center gap-2 text-sm">
              <UserCheck size={14} className={p.submitted_at ? 'text-emerald-500' : 'text-content-faint'} />
              <span>{p.display_name}</span>
              <span className="text-xs text-content-faint">{p.submitted_at ? 'đã nhập' : 'đang nhập…'}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function CandidateSection({
  candidates,
  addablePlaces,
  searchQuery,
  suggestions,
  searching,
  picked,
  pickLoading,
  addingPick,
  pickedIsDuplicate,
  onSearchChange,
  onPickSuggestion,
  onDismissPick,
  onAddPicked,
  onAdd,
  onCreate,
  onRemove,
  onSaveContext,
}: {
  candidates: DecisionCandidate[]
  addablePlaces: { id: number | string; name: string }[]
  searchQuery: string
  suggestions: VenueSuggestion[]
  searching: boolean
  picked: VenuePick | null
  pickLoading: boolean
  addingPick: boolean
  pickedIsDuplicate: boolean
  onSearchChange: (q: string) => void
  onPickSuggestion: (s: VenueSuggestion) => void
  onDismissPick: () => void
  onAddPicked: () => void
  onAdd: (placeId: number | string) => void
  onCreate: (name: string, lat: number | null, lng: number | null) => void
  onRemove: (candidateId: number | string) => void
  onSaveContext: (candidateId: number | string, body: UpsertVenueContextRequest) => Promise<boolean>
}) {
  const [showManual, setShowManual] = useState(false)

  return (
    <section className="mb-6 rounded-xl border border-edge bg-surface-card p-4">
      <h2 className="mb-3 flex items-center gap-2 font-semibold">
        <MapPin size={16} className="text-accent" /> Quán đề cử ({candidates.length})
      </h2>

      <ul className="mb-3 space-y-1.5">
        {candidates.map(c => (
          <CandidateRow key={c.id} candidate={c} onRemove={onRemove} onSaveContext={onSaveContext} />
        ))}
      </ul>

      {/* TREK place search — the primary add path (M2-02). */}
      <div className="relative mb-3">
        <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-content-faint" />
        <input
          value={searchQuery}
          onChange={e => onSearchChange(e.target.value)}
          placeholder="Tìm quán cà phê, trà sữa…"
          className="w-full rounded-lg border border-edge bg-surface pl-9 pr-3 py-2 text-sm"
        />
        {searching && <p className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-content-faint">…</p>}
        {suggestions.length > 0 && !picked && (
          <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-edge bg-surface-card shadow-lg">
            {suggestions.map((s, i) => (
              <li key={`${s.placeId}-${i}`}>
                <button
                  type="button"
                  onClick={() => onPickSuggestion(s)}
                  className="block w-full px-3 py-2 text-left text-sm hover:bg-surface-hover"
                >
                  <span className="block font-medium">{s.mainText}</span>
                  <span className="block truncate text-xs text-content-faint">{s.secondaryText}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {pickLoading && <p className="mb-3 text-xs text-content-faint">Đang tải thông tin quán…</p>}
      {picked && (
        <PickPreview pick={picked} duplicate={pickedIsDuplicate} adding={addingPick} onAdd={onAddPicked} onDismiss={onDismissPick} />
      )}

      {addablePlaces.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {addablePlaces.map(p => (
            <button
              key={p.id}
              type="button"
              onClick={() => onAdd(p.id)}
              className="rounded-full border border-edge px-2.5 py-1 text-xs text-content-secondary hover:border-accent"
            >
              + {p.name}
            </button>
          ))}
        </div>
      )}

      {/* Manual quick-add stays as a dev affordance, collapsed by default. */}
      <button type="button" onClick={() => setShowManual(v => !v)} className="text-xs text-content-faint hover:text-content-secondary">
        {showManual ? 'Ẩn thêm thủ công' : 'Thêm thủ công (dev)'}
      </button>
      {showManual && <ManualAdd onCreate={onCreate} />}
    </section>
  )
}

function CandidateRow({
  candidate: c,
  onRemove,
  onSaveContext,
}: {
  candidate: DecisionCandidate
  onRemove: (id: number | string) => void
  onSaveContext: (candidateId: number | string, body: UpsertVenueContextRequest) => Promise<boolean>
}) {
  const [editing, setEditing] = useState(false)
  const s = c.snapshot
  const openLine = s?.opening_weekdays?.find(l => l.trim() !== '') ?? null
  return (
    <li className="rounded-lg bg-surface-hover px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
        {s?.image_url ? (
          <img src={s.image_url} alt="" className="h-11 w-11 shrink-0 rounded-lg object-cover" loading="lazy" />
        ) : (
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-surface">
            <MapPin size={16} className="text-content-faint" />
          </span>
        )}
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className="truncate">{s?.name ?? `#${c.id}`}</span>
            {s?.rating != null && (
              <span className="inline-flex items-center gap-0.5 text-xs text-amber-500">
                <Star size={11} fill="currentColor" /> {s.rating.toFixed(1)}{s.rating_count != null && ` (${s.rating_count})`}
              </span>
            )}
          </div>
          <div className="truncate text-xs text-content-faint">
            {[s?.address, s?.open_now === true ? 'Đang mở' : s?.open_now === false ? 'Đang đóng' : null, openLine].filter(Boolean).join(' · ')}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {s?.website && (
          <a href={s.website} target="_blank" rel="noreferrer" className="text-content-faint hover:text-accent" title="Website">
            <ExternalLink size={14} />
          </a>
        )}
        {s?.phone && (
          <a href={`tel:${s.phone}`} className="text-content-faint hover:text-accent" title={s.phone}>
            <Phone size={14} />
          </a>
        )}
        <button type="button" onClick={() => onRemove(c.id)} className="text-xs text-content-faint hover:text-red-500">
          Gỡ
        </button>
        <button
          type="button"
          onClick={() => setEditing(v => !v)}
          aria-label="Chi tiết quán"
          aria-expanded={editing}
          className="text-xs text-content-faint hover:text-accent"
        >
          Chi tiết
        </button>
      </div>
      </div>
      {editing && (
        <VenueContextEditor
          candidate={c}
          onSave={async body => {
            const ok = await onSaveContext(c.id, body)
            if (ok) setEditing(false)
          }}
        />
      )}
    </li>
  )
}

const NOISE_OPTS: { v: string; label: string }[] = [
  { v: '', label: '—' },
  { v: 'QUIET', label: 'Yên tĩnh' },
  { v: 'MODERATE', label: 'Vừa vặn' },
  { v: 'LIVELY', label: 'Sôi động' },
]
const PRICE_OPTS = [
  { v: '', label: '—' },
  { v: 'LOW', label: 'Giá rẻ' },
  { v: 'MEDIUM', label: 'Tầm trung' },
  { v: 'HIGH', label: 'Cao cấp' },
]
const PARKING_OPTS = [
  { v: '', label: '—' },
  { v: 'NONE', label: 'Không chỗ đỗ' },
  { v: 'LIMITED', label: 'Đỗ xe hạn chế' },
  { v: 'EASY', label: 'Đỗ xe dễ' },
]
const FIT_OPTS = [
  { v: '', label: '—' },
  { v: '1', label: '1' },
  { v: '2', label: '2' },
  { v: '3', label: '3' },
  { v: '4', label: '4' },
  { v: '5', label: '5' },
]

/**
 * The host's manual VenueContext edit surface (M2-08). Untouched dims stay
 * UNKNOWN/null on save — "we didn't check" is honest data, not a guess.
 */
function VenueContextEditor({
  candidate: c,
  onSave,
}: {
  candidate: DecisionCandidate
  onSave: (body: UpsertVenueContextRequest) => Promise<void>
}) {
  const ctx = c.venue_context
  const [noise, setNoise] = useState(ctx?.noise_level === 'UNKNOWN' ? '' : ctx?.noise_level ?? '')
  const [price, setPrice] = useState(ctx?.price_band === 'UNKNOWN' ? '' : ctx?.price_band ?? '')
  const [parking, setParking] = useState(ctx?.parking === 'UNKNOWN' ? '' : ctx?.parking ?? '')
  const [groupFit, setGroupFit] = useState(ctx?.group_friendliness != null ? String(ctx.group_friendliness) : '')
  const [laptopFit, setLaptopFit] = useState(ctx?.laptop_friendliness != null ? String(ctx.laptop_friendliness) : '')
  const [photoFit, setPhotoFit] = useState(ctx?.photo_friendliness != null ? String(ctx.photo_friendliness) : '')
  const [vibeTags, setVibeTags] = useState((ctx?.vibe_tags ?? []).join(', '))
  const [drinkTags, setDrinkTags] = useState((ctx?.drink_tags ?? []).join(', '))
  const [occasionTags, setOccasionTags] = useState((ctx?.occasion_tags ?? []).join(', '))
  const [saving, setSaving] = useState(false)

  const selectCls = 'rounded border border-edge bg-surface px-1.5 py-1 text-xs'
  const tagInput = (label: string, value: string, set: (v: string) => void, ph: string) => (
    <label className="flex items-center gap-1.5 text-xs text-content-secondary">
      <span className="w-20 shrink-0">{label}</span>
      <input value={value} onChange={e => set(e.target.value)} placeholder={ph} className="w-full rounded border border-edge bg-surface px-1.5 py-1 text-xs" />
    </label>
  )
  const tagsOf = (raw: string) => raw.split(',').map(t => t.trim()).filter(Boolean).slice(0, 8)

  return (
    <div className="mt-2 grid gap-2 border-t border-edge pt-2 sm:grid-cols-2">
      <label className="flex items-center gap-1.5 text-xs text-content-secondary">
        <span className="w-20 shrink-0">Tiếng ồn</span>
        <select value={noise} onChange={e => setNoise(e.target.value)} className={selectCls}>
          {NOISE_OPTS.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-xs text-content-secondary">
        <span className="w-20 shrink-0">Giá</span>
        <select value={price} onChange={e => setPrice(e.target.value)} className={selectCls}>
          {PRICE_OPTS.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-xs text-content-secondary">
        <span className="w-20 shrink-0">Đỗ xe</span>
        <select value={parking} onChange={e => setParking(e.target.value)} className={selectCls}>
          {PARKING_OPTS.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-xs text-content-secondary">
        <span className="w-20 shrink-0">Hợp nhóm</span>
        <select value={groupFit} onChange={e => setGroupFit(e.target.value)} className={selectCls}>
          {FIT_OPTS.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-xs text-content-secondary">
        <span className="w-20 shrink-0">Làm việc</span>
        <select value={laptopFit} onChange={e => setLaptopFit(e.target.value)} className={selectCls}>
          {FIT_OPTS.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-xs text-content-secondary">
        <span className="w-20 shrink-0">Sống ảo</span>
        <select value={photoFit} onChange={e => setPhotoFit(e.target.value)} className={selectCls}>
          {FIT_OPTS.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
        </select>
      </label>
      <div className="grid gap-1.5 sm:col-span-2">
        {tagInput('Vibe tags', vibeTags, setVibeTags, 'yên tĩnh, vintage…')}
        {tagInput('Đồ uống', drinkTags, setDrinkTags, 'coffee, trà, matcha…')}
        {tagInput('Dịp', occasionTags, setOccasionTags, 'hẹn hò, họp nhóm…')}
      </div>
      <button
        type="button"
        disabled={saving}
        onClick={async () => {
          setSaving(true)
          try {
            await onSave({
              noise_level: noise === '' ? 'UNKNOWN' : (noise as 'QUIET' | 'MODERATE' | 'LIVELY'),
              price_band: price === '' ? 'UNKNOWN' : (price as 'LOW' | 'MEDIUM' | 'HIGH'),
              parking: parking === '' ? 'UNKNOWN' : (parking as 'NONE' | 'LIMITED' | 'EASY'),
              group_friendliness: groupFit === '' ? null : Number(groupFit),
              laptop_friendliness: laptopFit === '' ? null : Number(laptopFit),
              photo_friendliness: photoFit === '' ? null : Number(photoFit),
              vibe_tags: tagsOf(vibeTags),
              drink_tags: tagsOf(drinkTags),
              occasion_tags: tagsOf(occasionTags),
            })
          } finally {
            setSaving(false)
          }
        }}
        className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-text disabled:opacity-50 sm:col-span-2 sm:justify-self-start"
      >
        {saving ? 'Đang lưu…' : 'Lưu chi tiết'}
      </button>
    </div>
  )
}

function PickPreview({
  pick,
  duplicate,
  adding,
  onAdd,
  onDismiss,
}: {
  pick: VenuePick
  duplicate: boolean
  adding: boolean
  onAdd: () => void
  onDismiss: () => void
}) {
  return (
    <div className="mb-3 flex gap-3 rounded-lg border border-accent bg-surface p-3">
      {pick.photo_url ? (
        <img src={pick.photo_url} alt="" className="h-20 w-20 shrink-0 rounded-lg object-cover" loading="lazy" />
      ) : (
        <span className="flex h-20 w-20 shrink-0 items-center justify-center rounded-lg bg-surface-hover">
          <MapPin size={20} className="text-content-faint" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="font-medium">{pick.name}</div>
            {pick.address && <div className="truncate text-xs text-content-faint">{pick.address}</div>}
          </div>
          <button type="button" onClick={onDismiss} className="text-content-faint hover:text-content" aria-label="Đóng">
            <X size={15} />
          </button>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-content-secondary">
          {pick.rating != null && (
            <span className="inline-flex items-center gap-0.5 text-amber-500">
              <Star size={11} fill="currentColor" /> {pick.rating.toFixed(1)}{pick.rating_count != null && ` (${pick.rating_count})`}
            </span>
          )}
          {pick.open_now === true && <span className="text-emerald-500">Đang mở</span>}
          {pick.open_now === false && <span className="text-red-400">Đang đóng</span>}
          {pick.website && (
            <a href={pick.website} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-accent">
              <ExternalLink size={11} /> Website
            </a>
          )}
          {pick.facts?.cuisine && <span className="text-content-faint">{pick.facts.cuisine}</span>}
          {pick.facts?.internet_access === 'yes' && <span className="text-content-faint">wifi</span>}
        </div>
        <button
          type="button"
          disabled={adding || duplicate}
          onClick={onAdd}
          className="mt-2 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-accent-text disabled:opacity-50"
        >
          {duplicate ? 'Đã có trong danh sách' : adding ? 'Đang thêm…' : 'Thêm vào danh sách'}
        </button>
      </div>
    </div>
  )
}

function ManualAdd({ onCreate }: { onCreate: (name: string, lat: number | null, lng: number | null) => void }) {
  const [newName, setNewName] = useState('')
  const [newLat, setNewLat] = useState('')
  const [newLng, setNewLng] = useState('')

  const submitNew = () => {
    const name = newName.trim()
    if (!name) return
    onCreate(name, newLat.trim() === '' ? null : Number(newLat), newLng.trim() === '' ? null : Number(newLng))
    setNewName('')
    setNewLat('')
    setNewLng('')
  }

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      <input
        value={newName}
        onChange={e => setNewName(e.target.value)}
        placeholder="Tên quán mới"
        className="min-w-40 flex-1 rounded-lg border border-edge bg-surface px-2.5 py-1.5 text-sm"
      />
      <input value={newLat} onChange={e => setNewLat(e.target.value)} placeholder="lat" className="w-24 rounded-lg border border-edge bg-surface px-2.5 py-1.5 text-sm" />
      <input value={newLng} onChange={e => setNewLng(e.target.value)} placeholder="lng" className="w-24 rounded-lg border border-edge bg-surface px-2.5 py-1.5 text-sm" />
      <button type="button" onClick={submitNew} className="rounded-lg bg-surface-hover px-3 py-1.5 text-sm font-medium">
        Thêm
      </button>
    </div>
  )
}

function RecommendationList({
  result,
  selectedId,
  sessionStatus,
  onSelect,
  onFeedback,
  onNavigate,
}: {
  result: RecommendationResult
  selectedId: number | string | null
  sessionStatus: string
  onSelect: (candidateId: number | string) => void
  onFeedback: (candidateId: number, fit: number, again: boolean, reason: string | null) => void
  onNavigate: () => void
}) {
  return (
    <section>
      <h2 className="mb-3 font-semibold">Gợi ý của nhóm</h2>
      <ol className="space-y-3">
        {result.items.map(item => {
          const sel = selectedId != null && String(selectedId) === String(item.candidate_id)
          return (
            <li
              key={item.id}
              className={`rounded-xl border p-4 ${sel ? 'border-accent bg-surface-card' : 'border-edge bg-surface-card'}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-semibold">
                    #{item.rank} {item.candidate.snapshot?.name ?? `Quán ${item.candidate_id}`}
                    {!item.eligible && <span className="ml-2 text-xs text-red-500">bị loại</span>}
                  </div>
                  <div className="text-sm text-accent">{item.explanation?.headline}</div>
                </div>
                {/* No visible % — internal strategy score stays off consumer UI (M2-06). */}
              </div>

              {item.explanation && (
                <div className="mt-2 text-sm">
                  {item.explanation.strengths.map((s, i) => (
                    <p key={i} className="text-content-secondary">• {s}</p>
                  ))}
                  {item.explanation.tradeoffs.map((s, i) => (
                    <p key={i} className="text-content-faint">• {s}</p>
                  ))}
                  <div className="mt-2 flex flex-wrap gap-2 text-xs text-content-faint">
                    {item.explanation.travel_times.map(tt => (
                      <span key={tt.participant_id} className="inline-flex items-center gap-1 rounded-full bg-surface-hover px-2 py-0.5">
                        <Navigation size={11} /> {tt.display_name}: {tt.status === 'ok' ? fmtMin(tt.duration_seconds) : 'không rõ'}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-3 flex items-center gap-2">
                {(sessionStatus === 'resolved' || sessionStatus === 'selected') && item.eligible && (
                  <button
                    type="button"
                    onClick={() => onSelect(item.candidate_id)}
                    className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${sel ? 'bg-surface-hover text-content' : 'bg-accent text-accent-text'}`}
                  >
                    {sel ? 'Đã chọn — chọn lại?' : 'Chọn quán này'}
                  </button>
                )}
                {sel && item.candidate.snapshot?.lat != null && item.candidate.snapshot?.lng != null && (
                  <a
                    className="inline-flex items-center gap-1 text-sm text-accent"
                    href={`https://www.google.com/maps/dir/?api=1&destination=${item.candidate.snapshot.lat},${item.candidate.snapshot.lng}`}
                    target="_blank"
                    rel="noreferrer"
                    onClick={onNavigate}
                  >
                    <Navigation size={13} /> Điều hướng
                  </a>
                )}
              </div>
              {sel && <FeedbackForm candidateId={Number(item.candidate_id)} onSubmit={onFeedback} />}
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function FeedbackForm({
  candidateId,
  onSubmit,
}: {
  candidateId: number
  onSubmit: (candidateId: number, fit: number, again: boolean, reason: string | null) => void
}) {
  const [fit, setFit] = useState(4)
  const [again, setAgain] = useState(true)
  const [reason, setReason] = useState('')
  const [sent, setSent] = useState(false)
  if (sent) return <p className="mt-3 text-xs text-content-faint">Đã ghi nhận cảm nhận — cảm ơn!</p>
  return (
    <div className="mt-3 rounded-lg border border-edge p-3">
      <div className="mb-2 flex items-center gap-2 text-sm">
        <Star size={14} className="text-accent" />
        Mức độ hợp ý:
        {[1, 2, 3, 4, 5].map(n => (
          <button key={n} type="button" onClick={() => setFit(n)} className={`rounded px-1.5 py-0.5 text-xs ${fit === n ? 'bg-accent text-accent-text' : 'bg-surface-hover'}`}>
            {n}
          </button>
        ))}
      </div>
      <div className="mb-2 flex items-center gap-3 text-sm">
        Lần sau có chọn lại không?
        <button type="button" onClick={() => setAgain(true)} className={`rounded px-2 py-0.5 text-xs ${again ? 'bg-accent text-accent-text' : 'bg-surface-hover'}`}>Có</button>
        <button type="button" onClick={() => setAgain(false)} className={`rounded px-2 py-0.5 text-xs ${!again ? 'bg-accent text-accent-text' : 'bg-surface-hover'}`}>Không</button>
      </div>
      <input
        value={reason}
        onChange={e => setReason(e.target.value)}
        placeholder="Tiếc gì không? (tuỳ chọn)"
        className="mb-2 w-full rounded-lg border border-edge bg-surface px-2.5 py-1.5 text-sm"
      />
      <button
        type="button"
        onClick={() => { onSubmit(candidateId, fit, again, reason.trim() || null); setSent(true) }}
        className="rounded-lg bg-surface-hover px-3 py-1.5 text-sm font-medium"
      >
        Gửi cảm nhận
      </button>
    </div>
  )
}

/**
 * M2-09 — the comparison map: participant origins as origin pins, the Top-3
 * venues as numbered pins, the locked-in venue highlighted. The fairness view
 * is the small candidate picker: origin tooltips relabel with every member's
 * travel time to the chosen candidate, so the geometry explains who travels
 * how far. Runs through MapViewAuto → both map renderers stay supported.
 */
function DecisionMap({
  items,
  selectedId,
  participants,
  tripId,
}: {
  items: RecommendationResult['items']
  selectedId: number | null
  participants: RosterEntry[]
  tripId: number
}) {
  const [viewCandidateId, setViewCandidateId] = useState<number | null>(null)
  const defaultCandidateId = selectedId ?? items[0]?.candidate_id ?? null
  const viewItem = items.find(i => i.candidate_id === (viewCandidateId ?? defaultCandidateId)) ?? items[0]

  const topPlaces = items.slice(0, 3).flatMap(item => {
    const snap = item.candidate.snapshot
    if (typeof snap?.lat !== 'number' || typeof snap?.lng !== 'number') return []
    return [{ id: item.candidate.place_id, name: snap.name, lat: snap.lat, lng: snap.lng, image_url: snap.image_url ?? null }]
  })
  const orderMap = Object.fromEntries(
    items.slice(0, 3).map(item => [item.candidate.place_id, item.rank == null ? null : [item.rank]]),
  )
  const selectedPlaceId = selectedId != null
    ? items.find(i => i.candidate_id === selectedId)?.candidate.place_id ?? null
    : null

  const origins = participants.flatMap(p => {
    if (typeof p.origin_lat !== 'number' || typeof p.origin_lng !== 'number') return []
    const tt = viewItem?.explanation?.travel_times.find(t => t.participant_id === p.id)
    const dur = tt && tt.status === 'ok' ? ` · ~${fmtMin(tt.duration_seconds)}` : ''
    const poi: Poi = {
      osm_id: `origin-${p.id}`,
      name: `${p.display_name}${dur}`,
      lat: p.origin_lat,
      lng: p.origin_lng,
      category: 'origin',
      poi_type: 'origin',
      address: 'origin_label' in p ? p.origin_label ?? null : null,
      website: null,
      phone: null,
      opening_hours: null,
      cuisine: null,
      source: 'decision',
    }
    return [poi]
  })

  const focusPoints: [number, number][] = [
    ...origins.map(o => [o.lat, o.lng] as [number, number]),
    ...topPlaces.map(pl => [pl.lat, pl.lng] as [number, number]),
  ]
  if (focusPoints.length === 0) return null

  return (
    <section className="mb-6 rounded-xl border border-edge bg-surface-card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold">
          <MapPin size={16} className="text-accent" /> Bản đồ so sánh
        </h2>
        <div className="flex items-center gap-1 text-xs">
          <span className="text-content-faint">Giờ đi tới:</span>
          {items.slice(0, 3).map(item => {
            const active = (viewCandidateId ?? defaultCandidateId) === item.candidate_id
            return (
              <button
                key={item.candidate_id}
                type="button"
                onClick={() => setViewCandidateId(item.candidate_id)}
                className={`rounded-full px-2 py-0.5 font-semibold ${active ? 'bg-accent text-accent-text' : 'bg-surface-hover text-content-secondary'}`}
              >
                #{item.rank ?? '—'}
              </button>
            )
          })}
        </div>
      </div>
      <div className="relative h-72 w-full overflow-hidden rounded-xl border border-edge">
        <MapViewAuto
          places={topPlaces}
          dayOrderMap={orderMap}
          selectedPlaceId={selectedPlaceId}
          pois={origins}
          focusPoints={focusPoints}
          tripId={tripId}
        />
      </div>
      <p className="mt-2 text-xs text-content-faint">
        Ghim xanh dương = điểm xuất phát của từng người (tooltip ghi giờ đi tới quán đang xem); pin có số = Top 3 gợi ý.
      </p>
    </section>
  )
}
