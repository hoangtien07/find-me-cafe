import { Injectable } from '@nestjs/common';
import crypto from 'node:crypto';
import type {
  DecisionConstraint,
  DecisionParticipant,
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
