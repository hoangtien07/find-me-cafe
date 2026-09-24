import { Injectable } from '@nestjs/common';
import crypto from 'node:crypto';
import type {
  DecisionCandidate,
  DecisionConstraint,
  DecisionFeedback,
  DecisionParticipant,
  DecisionSelection,
  DecisionParticipantRosterEntry,
  DecisionParticipantSessionResponse,
  DecisionPreference,
  DecisionInvite,
  DecisionInvitePreview,
  DecisionSession,
  DecisionStatus,
  DecisionTravelMode,
  UpdateDecisionRequest,
  UpdateParticipantContextRequest,
} from '@trek/shared';
import { DECISION_TRAVEL_MODES } from '@trek/shared';
import { DatabaseService } from '../database/database.service';
import { RealtimeService } from '../realtime/realtime.service';
import { DecisionTelemetryService } from './decision-telemetry.service';
import { ValidationError, NotFoundError } from '../common/domain-errors';

/** The decision_sessions row joined with the technical trip's title — the wire shape. */
export interface DecisionSessionRow {
  id: number;
  trip_id: number;
  status: DecisionStatus;
  occasion: string | null;
  scheduled_at: string | null;
  travel_mode: DecisionTravelMode;
  currency: string;
  created_by_user_id: number;
  created_at: string;
  updated_at: string;
  title: string;
}

/** Host-driven lifecycle moves; 'resolving'/'resolved'/'selected' are earned by resolve/select, never PATCHed. */
const ALLOWED_STATUS_TRANSITIONS: Record<DecisionStatus, DecisionStatus[]> = {
  collecting: ['ready', 'canceled'],
  ready: ['collecting', 'canceled'],
  resolving: ['canceled'],
  resolved: ['closed', 'canceled'],
  selected: ['closed', 'canceled'],
  closed: [],
  canceled: [],
};

const DECISION_SESSION_SELECT = `
  SELECT ds.id, ds.trip_id, ds.status, ds.occasion, ds.scheduled_at, ds.travel_mode,
         ds.currency, ds.created_by_user_id, ds.created_at, ds.updated_at,
         t.title AS title
    FROM decision_sessions ds
    JOIN trips t ON t.id = ds.trip_id
`;

/**
 * The decision room's server domain: lifecycle of the session and the state
 * rows that hang off it (participants, candidates, runs). A DecisionSession is
 * a 1:1 overlay on a technical TREK trip — the trip is created as the
 * collaboration container (its room carries the decision:* WS broadcasts, its
 * places become the candidate venues) while the decision state lives in its
 * own tables, per docs/decision/PRODUCT_SPEC.md.
 */
@Injectable()
export class DecisionService {
  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeService,
    private readonly telemetry: DecisionTelemetryService,
  ) {}

  /** Create the technical trip + the decision session atomically. */
  create(userId: number, data: { title: string; occasion?: string | null; scheduled_at?: string | null; travel_mode?: DecisionTravelMode; currency?: string }): DecisionSession {
    const sessionId = this.db.transaction((conn) => {
      const scheduledDate = data.scheduled_at ? data.scheduled_at.slice(0, 10) : null;
      const tripRes = conn
        .prepare('INSERT INTO trips (user_id, title, start_date, end_date, currency) VALUES (?, ?, ?, ?, ?)')
        .run(userId, data.title, scheduledDate, scheduledDate, data.currency || 'VND');
      const tripId = Number(tripRes.lastInsertRowid);
      // One content-free day so the technical trip is a well-formed container.
      conn.prepare('INSERT INTO days (trip_id, day_number, date) VALUES (?, 1, ?)').run(tripId, scheduledDate);
      const res = conn
        .prepare(
          'INSERT INTO decision_sessions (trip_id, occasion, scheduled_at, travel_mode, currency, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          tripId,
          data.occasion ?? null,
          data.scheduled_at ?? null,
          data.travel_mode || 'driving',
          data.currency || 'VND',
          userId,
        );
      return Number(res.lastInsertRowid);
    });
    this.telemetry.track(sessionId, 'decision_created', { userId });
    return this.getSession(sessionId)!;
  }

  /** The session row joined with its technical trip's title. */
  getSession(id: number | string): DecisionSession | undefined {
    return this.db.get<DecisionSessionRow>(`${DECISION_SESSION_SELECT} WHERE ds.id = ?`, id);
  }

  /**
   * The session only when `userId` hosts it. A stranger gets undefined (404),
   * never a forbidden — the id must not be confirmed to exist.
   */
  getForHost(id: number | string, userId: number): DecisionSession | undefined {
    const session = this.getSession(id);
    if (!session || session.created_by_user_id !== userId) return undefined;
    return session;
  }

  /** All sessions a user hosts, newest first. */
  list(userId: number): DecisionSession[] {
    return this.db.all<DecisionSessionRow>(
      `${DECISION_SESSION_SELECT} WHERE ds.created_by_user_id = ? ORDER BY ds.created_at DESC`,
      userId,
    );
  }

  /**
   * Host-facing partial update: mutable fields plus the lifecycle moves a host
   * may make directly. `status` transitions go through ALLOWED_STATUS_TRANSITIONS;
   * 'resolving'/'resolved'/'selected' are rejected (those are earned by the
   * resolve and select flows, not editable state).
   */
  update(id: number | string, body: UpdateDecisionRequest): DecisionSession {
    const session = this.getSession(id);
    if (!session) throw new NotFoundError('Decision not found');

    if (body.status !== undefined && body.status !== session.status) {
      const allowed = ALLOWED_STATUS_TRANSITIONS[session.status as DecisionStatus] ?? [];
      if (!allowed.includes(body.status)) {
        throw new ValidationError(`Cannot move decision from ${session.status} to ${body.status}`);
      }
    }

    this.db.transaction((conn) => {
      if (body.title !== undefined) {
        conn.prepare('UPDATE trips SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(body.title, session.trip_id);
      }
      const fields: string[] = [];
      const values: unknown[] = [];
      if (body.occasion !== undefined) {
        fields.push('occasion = ?');
        values.push(body.occasion);
      }
      if (body.scheduled_at !== undefined) {
        fields.push('scheduled_at = ?');
        values.push(body.scheduled_at);
      }
      if (body.travel_mode !== undefined) {
        if (!DECISION_TRAVEL_MODES.includes(body.travel_mode)) {
          throw new ValidationError('Invalid travel mode');
        }
        fields.push('travel_mode = ?');
        values.push(body.travel_mode);
      }
      if (body.status !== undefined) {
        fields.push('status = ?');
        values.push(body.status);
      }
      if (fields.length > 0) {
        conn
          .prepare(`UPDATE decision_sessions SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(...values, id);
      }
    });

    const updated = this.getSession(id)!;
    if (body.status !== undefined && body.status !== session.status) {
      this.broadcastStatus(updated);
    }
    return updated;
  }

  /** Broadcast the session's status on the technical trip's room. */
  broadcastStatus(session: DecisionSession, socketId?: string): void {
    this.realtime.broadcast(String(session.trip_id), 'decision:status-updated', {
      decisionSessionId: session.id,
      status: session.status as DecisionStatus,
    }, socketId);
  }

  // ── Invite boundary ───────────────────────────────────────────────────────

  /** SHA-256 over a token — the only form persisted; plaintext exists once, in the response. */
  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /** Opaque 24-byte URL-safe token, same shape as the trip invite links. */
  private generateToken(): string {
    return crypto.randomBytes(24).toString('base64url');
  }

  /**
   * Mint an invite for a session. Returns the row plus the plaintext token —
   * the DB stores only its SHA-256 hash, so the token is revealed exactly once.
   */
  createInvite(sessionId: number, userId: number, expiresInDays?: number | null): DecisionInvite & { token: string } {
    const token = this.generateToken();
    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 86400_000).toISOString()
      : null;
    const res = this.db.run(
      'INSERT INTO decision_invites (decision_session_id, token_hash, expires_at, created_by_user_id) VALUES (?, ?, ?, ?)',
      sessionId,
      this.hashToken(token),
      expiresAt,
      userId,
    );
    const invite = this.db.get<Omit<DecisionInvite, never>>(
      'SELECT id, decision_session_id, expires_at, revoked_at, created_by_user_id, created_at FROM decision_invites WHERE id = ?',
      Number(res.lastInsertRowid),
    )!;
    this.telemetry.track(sessionId, 'invite_created', { userId });
    return { ...invite, token };
  }

  /** An invite row when the token is valid — exists, unrevoked, unexpired. */
  private findLiveInvite(token: string): { id: number; decision_session_id: number } | undefined {
    return this.db.get<{ id: number; decision_session_id: number }>(
      `SELECT id, decision_session_id FROM decision_invites
        WHERE token_hash = ?
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)`,
      this.hashToken(token),
    );
  }

  /**
   * Public invite preview — the minimum a stranger needs before joining.
   * Deliberately no participant rows or names: previewing an invite reveals
   * the outing, not who is in it.
   */
  previewInvite(token: string): DecisionInvitePreview | undefined {
    const invite = this.findLiveInvite(token);
    if (!invite) return undefined;
    const session = this.db.get<{ title: string; occasion: string | null; scheduled_at: string | null; status: DecisionStatus }>(
      `${DECISION_SESSION_SELECT} WHERE ds.id = ?`,
      invite.decision_session_id,
    );
    if (!session) return undefined;
    const { n } = this.db.get<{ n: number }>(
      'SELECT COUNT(*) n FROM decision_participants WHERE decision_session_id = ?',
      invite.decision_session_id,
    )!;
    return {
      title: session.title,
      occasion: session.occasion,
      scheduled_at: session.scheduled_at,
      status: session.status,
      participant_count: n,
      expires_at: null,
    };
  }

  /** Statuses where a stranger may still join the room. */
  private static JOINABLE_STATUSES: DecisionStatus[] = ['collecting', 'ready'];

  /**
   * Anonymous join: mint the participant row plus a scoped participant session
   * (its own SHA-256-hashed token — never the TREK global JWT, never an
   * is_guest user). Inline context, when present, is applied the same way a
   * PUT /context would persist it.
   */
  joinByInvite(
    token: string,
    displayName: string,
    context?: UpdateParticipantContextRequest,
  ): { participant: DecisionParticipant; participant_token: string } | undefined {
    const invite = this.findLiveInvite(token);
    if (!invite) return undefined;
    const session = this.db.get<{ id: number; status: DecisionStatus; trip_id: number }>(
      `${DECISION_SESSION_SELECT} WHERE ds.id = ?`,
      invite.decision_session_id,
    );
    if (!session || !DecisionService.JOINABLE_STATUSES.includes(session.status)) return undefined;

    const participantToken = this.generateToken();
    const participantId = this.db.transaction((conn) => {
      const res = conn
        .prepare('INSERT INTO decision_participants (decision_session_id, display_name) VALUES (?, ?)')
        .run(invite.decision_session_id, displayName);
      const pid = Number(res.lastInsertRowid);
      conn
        .prepare('INSERT INTO decision_participant_sessions (participant_id, token_hash) VALUES (?, ?)')
        .run(pid, this.hashToken(participantToken));
      return pid;
    });

    this.telemetry.track(invite.decision_session_id, 'participant_joined', { participantId });
    if (context) this.applyParticipantContext(participantId, invite.decision_session_id, context);

    const participant = this.getParticipant(participantId)!;
    this.broadcastParticipant(session.trip_id, participant, 'decision:participant-joined');
    return { participant, participant_token: participantToken };
  }

  /** A participant row by id. */
  getParticipant(participantId: number): DecisionParticipant | undefined {
    return this.db.get<DecisionParticipant>(
      'SELECT * FROM decision_participants WHERE id = ?',
      participantId,
    );
  }

  /**
   * Resolve the scoped participant credential — unrevoked and unexpired. A bad
   * token returns undefined, indistinguishable from one that never existed.
   */
  findParticipantByToken(token: string): DecisionParticipant | undefined {
    const row = this.db.get<{ participant_id: number }>(
      `SELECT participant_id FROM decision_participant_sessions
        WHERE token_hash = ?
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)`,
      this.hashToken(token),
    );
    return row ? this.getParticipant(row.participant_id) : undefined;
  }

  /**
   * GET /api/decision-participant/session — the room the participant joined,
   * the roster projected to what strangers may see, and their own context
   * (preferences + deal-breakers) for the intake form.
   */
  participantSessionView(participantId: number): DecisionParticipantSessionResponse | undefined {
    const participant = this.getParticipant(participantId);
    if (!participant) return undefined;
    const decision = this.getSession(participant.decision_session_id);
    if (!decision) return undefined;
    const participants = this.db.all<DecisionParticipantRosterEntry>(
      'SELECT id, display_name, submitted_at FROM decision_participants WHERE decision_session_id = ? ORDER BY created_at',
      participant.decision_session_id,
    );
    const preferences = this.db
      .all<Record<string, unknown>>(
        'SELECT id, participant_id, key, value, weight, is_hard FROM decision_preferences WHERE participant_id = ? ORDER BY id',
        participantId,
      )
      .map((p) => ({ ...p, is_hard: Boolean(p.is_hard) }) as DecisionPreference);
    const dealBreakers = this.db
      .all<Record<string, unknown>>(
        'SELECT id, decision_session_id, participant_id, type, operator, value_json, is_hard FROM decision_constraints WHERE participant_id = ? ORDER BY id',
        participantId,
      )
      .map(
        (c) =>
          ({
            id: c.id,
            decision_session_id: c.decision_session_id,
            participant_id: c.participant_id,
            type: c.type,
            operator: c.operator,
            value: typeof c.value_json === 'string' ? JSON.parse(c.value_json) : c.value_json,
            is_hard: Boolean(c.is_hard),
          }) as DecisionConstraint,
      );
    return { participant, decision, participants, preferences, deal_breakers: dealBreakers };
  }

  /**
   * PUT /api/decision-participant/context — persist the intake, stamp
   * submitted_at, and tell the room via the technical trip's WS room.
   */
  updateParticipantContext(
    participantId: number,
    sessionId: number,
    ctx: UpdateParticipantContextRequest,
  ): DecisionParticipant {
    this.applyParticipantContext(participantId, sessionId, ctx);
    this.telemetry.track(sessionId, 'participant_context_submitted', { participantId });
    const participant = this.getParticipant(participantId)!;
    const session = this.getSession(sessionId);
    if (session) this.broadcastParticipant(session.trip_id, participant, 'decision:participant-updated');
    return participant;
  }

  /** Participants of a session (host view). */
  listParticipants(sessionId: number): DecisionParticipant[] {
    return this.db.all<DecisionParticipant>(
      'SELECT * FROM decision_participants WHERE decision_session_id = ? ORDER BY created_at',
      sessionId,
    );
  }

  /**
   * Replace a participant's whole context in one transaction: scalars on the
   * participant row, the preference set (≤3), and deal-breakers (always
   * persisted as hard constraints). submitted_at is stamped so the room knows
   * the person finished the intake.
   */
  applyParticipantContext(
    participantId: number,
    sessionId: number,
    ctx: UpdateParticipantContextRequest,
  ): void {
    this.db.transaction((conn) => {
      const fields: string[] = [];
      const values: unknown[] = [];
      if (ctx.origin !== undefined) {
        fields.push('origin_lat = ?', 'origin_lng = ?', 'origin_label = ?');
        values.push(ctx.origin?.lat ?? null, ctx.origin?.lng ?? null, ctx.origin?.label ?? null);
      }
      if (ctx.max_travel_minutes !== undefined) {
        fields.push('max_travel_minutes = ?');
        values.push(ctx.max_travel_minutes);
      }
      if (ctx.budget_min !== undefined) {
        fields.push('budget_min = ?');
        values.push(ctx.budget_min);
      }
      if (ctx.budget_max !== undefined) {
        fields.push('budget_max = ?');
        values.push(ctx.budget_max);
      }
      fields.push('submitted_at = CURRENT_TIMESTAMP', 'updated_at = CURRENT_TIMESTAMP');
      conn
        .prepare(`UPDATE decision_participants SET ${fields.join(', ')} WHERE id = ?`)
        .run(...values, participantId);

      if (ctx.preferences !== undefined) {
        conn.prepare('DELETE FROM decision_preferences WHERE participant_id = ?').run(participantId);
        const ins = conn.prepare(
          'INSERT INTO decision_preferences (participant_id, key, value, weight, is_hard) VALUES (?, ?, ?, ?, ?)',
        );
        for (const p of ctx.preferences) {
          ins.run(participantId, p.key, p.value, p.weight ?? 1.0, p.is_hard ? 1 : 0);
        }
      }
      if (ctx.deal_breakers !== undefined) {
        conn.prepare('DELETE FROM decision_constraints WHERE participant_id = ?').run(participantId);
        const ins = conn.prepare(
          'INSERT INTO decision_constraints (decision_session_id, participant_id, type, operator, value_json, is_hard) VALUES (?, ?, ?, ?, ?, 1)',
        );
        for (const d of ctx.deal_breakers) {
          ins.run(
            sessionId,
            participantId,
            d.type,
            d.operator ?? null,
            d.value === undefined ? null : JSON.stringify(d.value),
          );
        }
      }
    });
  }

  // ── Candidates ────────────────────────────────────────────────────────────

  /** A candidate row with its snapshot parsed for the wire. */
  private toCandidate(row: Record<string, unknown>): DecisionCandidate {
    return {
      ...row,
      snapshot: typeof row.snapshot_json === 'string' ? JSON.parse(row.snapshot_json) : null,
      snapshot_json: undefined,
    } as unknown as DecisionCandidate;
  }

  /** Candidates of a session, oldest first. */
  listCandidates(sessionId: number): DecisionCandidate[] {
    return this.db
      .all<Record<string, unknown>>(
        'SELECT * FROM decision_candidates WHERE decision_session_id = ? ORDER BY created_at',
        sessionId,
      )
      .map((r) => this.toCandidate(r));
  }

  /**
   * Pin a TREK Place as a candidate. The place must live on this session's
   * technical trip — a stranger place id returns NotFoundError, same as a bad
   * session. The snapshot freezes the evidence the resolver will later cite
   * (name, coords, category, price), so a host editing the Place afterwards
   * can't rewrite what the recommendation saw.
   */
  addCandidate(
    sessionId: number,
    placeId: number,
    addedBy: { type: 'host' | 'participant' | 'system'; id: number | null },
  ): DecisionCandidate {
    const session = this.getSession(sessionId);
    if (!session) throw new NotFoundError('Decision not found');
    const place = this.db.get<Record<string, unknown>>(
      `SELECT p.*, c.name AS category_name
         FROM places p LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.id = ? AND p.trip_id = ?`,
      placeId,
      session.trip_id,
    );
    if (!place) throw new NotFoundError('Place not found in this decision');

    const existing = this.db.get<{ id: number }>(
      'SELECT id FROM decision_candidates WHERE decision_session_id = ? AND place_id = ?',
      sessionId,
      placeId,
    );
    if (existing) throw new ValidationError('Place is already a candidate');

    const ratingRow = this.db.get<{ r: number | null }>(
      'SELECT AVG(rating) r FROM place_ratings WHERE place_id = ?',
      placeId,
    );
    const snapshot = {
      name: place.name,
      lat: place.lat ?? null,
      lng: place.lng ?? null,
      address: place.address ?? null,
      google_place_id: place.google_place_id ?? null,
      price: place.price ?? null,
      currency: place.currency ?? null,
      rating: ratingRow?.r ?? null,
      category: place.category_name ?? null,
      description: place.description ?? null,
      image_url: place.image_url ?? null,
    };

    const res = this.db.run(
      `INSERT INTO decision_candidates (decision_session_id, place_id, source, added_by_type, added_by_id, snapshot_json)
       VALUES (?, ?, 'manual', ?, ?, ?)`,
      sessionId,
      placeId,
      addedBy.type,
      addedBy.id,
      JSON.stringify(snapshot),
    );
    const candidate = this.db.get<Record<string, unknown>>(
      'SELECT * FROM decision_candidates WHERE id = ?',
      Number(res.lastInsertRowid),
    )!;
    const wire = this.toCandidate(candidate);
    this.telemetry.track(
      sessionId,
      'candidate_added',
      addedBy.type === 'host' ? { userId: addedBy.id ?? undefined } : { participantId: addedBy.id ?? undefined },
      { candidateId: wire.id },
    );
    this.realtime.broadcast(String(session.trip_id), 'decision:candidate-added', { candidate: wire });
    return wire;
  }

  /** Remove a candidate; the host's room hears decision:candidate-removed. */
  removeCandidate(sessionId: number, candidateId: number): void {
    const session = this.getSession(sessionId);
    if (!session) throw new NotFoundError('Decision not found');
    const res = this.db.run(
      'DELETE FROM decision_candidates WHERE id = ? AND decision_session_id = ?',
      candidateId,
      sessionId,
    );
    if (res.changes === 0) throw new NotFoundError('Candidate not found');
    this.realtime.broadcast(String(session.trip_id), 'decision:candidate-removed', {
      decisionSessionId: sessionId,
      candidateId,
    });
  }

  // ── Selection & feedback ──────────────────────────────────────────────────

  /**
   * Lock in the group's venue: one decision_selections row per session
   * (re-selecting replaces it), linked to the run that ranked it, and the
   * session flips to 'selected'. Broadcasts decision:selected + status-updated.
   */
  select(sessionId: number, candidateId: number, userId: number): DecisionSelection {
    const session = this.getSession(sessionId);
    if (!session) throw new NotFoundError('Decision not found');
    if (session.status !== 'resolved' && session.status !== 'selected') {
      throw new ValidationError(`Decision is ${session.status} — resolve first`);
    }
    const candidate = this.db.get<{ id: number }>(
      'SELECT id FROM decision_candidates WHERE id = ? AND decision_session_id = ?',
      candidateId,
      sessionId,
    );
    if (!candidate) throw new NotFoundError('Candidate not found in this decision');
    const run = this.db.get<{ id: number }>(
      "SELECT id FROM recommendation_runs WHERE decision_session_id = ? AND status = 'completed' ORDER BY id DESC LIMIT 1",
      sessionId,
    );

    this.db.transaction((conn) => {
      conn.prepare('DELETE FROM decision_selections WHERE decision_session_id = ?').run(sessionId);
      conn
        .prepare(
          'INSERT INTO decision_selections (decision_session_id, candidate_id, recommendation_run_id, selected_by_user_id) VALUES (?, ?, ?, ?)',
        )
        .run(sessionId, candidateId, run?.id ?? null, userId);
      conn
        .prepare("UPDATE decision_sessions SET status = 'selected', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(sessionId);
    });
    const selection = this.db.get<DecisionSelection>(
      'SELECT * FROM decision_selections WHERE decision_session_id = ?',
      sessionId,
    )!;
    this.telemetry.track(sessionId, 'venue_selected', { userId }, { candidateId, runId: run?.id ?? null });
    this.realtime.broadcast(String(session.trip_id), 'decision:selected', {
      decisionSessionId: sessionId,
      selection,
    });
    this.broadcastStatus({ ...session, status: 'selected' });
    return selection;
  }

  /** The session's locked-in selection, if any. */
  getSelection(sessionId: number): DecisionSelection | undefined {
    return this.db.get<DecisionSelection>(
      'SELECT * FROM decision_selections WHERE decision_session_id = ?',
      sessionId,
    );
  }

  /**
   * Post-outing feedback (spec §17: the learnable record). V1 asks three
   * questions per participant/host — fit 1-5, would_choose_again, regret reason.
   */
  addFeedback(
    sessionId: number,
    body: { candidate_id: number; fit_score: number; would_choose_again: boolean; regret_reason?: string | null },
    participantId: number | null,
  ): DecisionFeedback {
    const session = this.getSession(sessionId);
    if (!session) throw new NotFoundError('Decision not found');
    const candidate = this.db.get<{ id: number }>(
      'SELECT id FROM decision_candidates WHERE id = ? AND decision_session_id = ?',
      body.candidate_id,
      sessionId,
    );
    if (!candidate) throw new NotFoundError('Candidate not found in this decision');
    const res = this.db.run(
      `INSERT INTO decision_feedback (decision_session_id, participant_id, candidate_id, fit_score, would_choose_again, regret_reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
      sessionId,
      participantId,
      body.candidate_id,
      body.fit_score,
      body.would_choose_again ? 1 : 0,
      body.regret_reason ?? null,
    );
    const row = this.db.get<Record<string, unknown>>(
      'SELECT * FROM decision_feedback WHERE id = ?',
      Number(res.lastInsertRowid),
    )!;
    this.telemetry.track(
      sessionId,
      'feedback_submitted',
      participantId ? { participantId } : {},
      { candidateId: body.candidate_id, fitScore: body.fit_score },
    );
    return { ...row, would_choose_again: Boolean(row.would_choose_again) } as unknown as DecisionFeedback;
  }

  /** Broadcast a participant row on the technical trip's room. */
  private broadcastParticipant(
    tripId: number | string,
    participant: DecisionParticipant,
    event: 'decision:participant-joined' | 'decision:participant-updated',
    socketId?: string,
  ): void {
    this.realtime.broadcast(String(tripId), event, { participant }, socketId);
  }
}
