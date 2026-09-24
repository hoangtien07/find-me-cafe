import { Injectable } from '@nestjs/common';
import type {
  DecisionSession,
  DecisionStatus,
  DecisionTravelMode,
  UpdateDecisionRequest,
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
}
