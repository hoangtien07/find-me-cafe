import React, { useState } from 'react'
import { PageSpinner } from '../components/shared/Spinner'
import { Copy, MapPin, Navigation, Star, UserCheck, Users } from 'lucide-react'
import { useDecisionPage } from './decision/useDecisionPage'
import type {
  DecisionCandidate,
  DecisionParticipant,
  DecisionParticipantRosterEntry,
  RecommendationResult,
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
    handleInvite,
    handleAddCandidate,
    handleCreatePlace,
    handleRemoveCandidate,
    handleResolve,
    handleSelect,
    handleFeedback,
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
          onAdd={handleAddCandidate}
          onCreate={handleCreatePlace}
          onRemove={handleRemoveCandidate}
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
  onAdd,
  onCreate,
  onRemove,
}: {
  candidates: DecisionCandidate[]
  addablePlaces: { id: number | string; name: string }[]
  onAdd: (placeId: number | string) => void
  onCreate: (name: string, lat: number | null, lng: number | null) => void
  onRemove: (candidateId: number | string) => void
}) {
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
    <section className="mb-6 rounded-xl border border-edge bg-surface-card p-4">
      <h2 className="mb-3 flex items-center gap-2 font-semibold">
        <MapPin size={16} className="text-accent" /> Quán đề cử ({candidates.length})
      </h2>
      <ul className="mb-3 space-y-1.5">
        {candidates.map(c => (
          <li key={c.id} className="flex items-center justify-between gap-2 rounded-lg bg-surface-hover px-3 py-2 text-sm">
            <span>{c.snapshot?.name ?? `#${c.id}`}</span>
            <button type="button" onClick={() => onRemove(c.id)} className="text-xs text-content-faint hover:text-red-500">
              Gỡ
            </button>
          </li>
        ))}
      </ul>
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
      <div className="flex flex-wrap gap-2">
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
    </section>
  )
}

function RecommendationList({
  result,
  selectedId,
  sessionStatus,
  onSelect,
  onFeedback,
}: {
  result: RecommendationResult
  selectedId: number | string | null
  sessionStatus: string
  onSelect: (candidateId: number | string) => void
  onFeedback: (candidateId: number, fit: number, again: boolean, reason: string | null) => void
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
                <div className="text-right text-sm text-content-secondary">
                  {(item.total_score * 100).toFixed(0)}%
                </div>
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
