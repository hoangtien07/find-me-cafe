import { Injectable } from '@nestjs/common';
import {
  DECISION_EVENT_TYPES,
  type DecisionEvent,
  type DecisionEventType,
  type DecisionSessionMetrics,
} from '@trek/shared';
import { DatabaseService } from '../database/database.service';

/**
 * VS-13 — the DecisionGraph funnel (plan Phase 15): append-only product
 * events in decision_events, separate from the realtime broadcasts. Each row
 * records who (user or scoped participant) did what, with optional JSON
 * metadata (run id, selected rank…) for post-hoc funnel analysis. V1 records;
 * no adaptive ranking consumes it yet.
 */
@Injectable()
export class DecisionTelemetryService {
  constructor(private readonly db: DatabaseService) {}

  track(
    decisionSessionId: number,
    type: DecisionEventType,
    actor: { userId?: number; participantId?: number } = {},
    metadata: Record<string, unknown> | null = null,
  ): DecisionEvent {
    const res = this.db.run(
      'INSERT INTO decision_events (decision_session_id, type, user_id, participant_id, metadata) VALUES (?, ?, ?, ?, ?)',
      decisionSessionId,
      type,
      actor.userId ?? null,
      actor.participantId ?? null,
      metadata === null ? null : JSON.stringify(metadata),
    );
    const row = this.db.get<DecisionEvent & { metadata: string | null }>(
      'SELECT * FROM decision_events WHERE id = ?',
      Number(res.lastInsertRowid),
    )!;
    return { ...row, metadata: row.metadata === null ? null : JSON.parse(row.metadata) };
  }

  listForSession(decisionSessionId: number): DecisionEvent[] {
    const rows = this.db.all<DecisionEvent & { metadata: string | null }>(
      'SELECT * FROM decision_events WHERE decision_session_id = ? ORDER BY id',
      decisionSessionId,
    );
    return rows.map((r) => ({ ...r, metadata: r.metadata === null ? null : JSON.parse(r.metadata) }));
  }

  /**
   * M2-11 — the basic funnel read: every event type zero-filled, the room's
   * intake progress, and the learnable record's tail aggregated. Rates come
   * back null when there's nothing to average so an empty room doesn't look
   * like a bad room.
   */
  metrics(decisionSessionId: number): DecisionSessionMetrics {
    const counts = Object.fromEntries(DECISION_EVENT_TYPES.map((t) => [t, 0])) as Record<
      DecisionEventType,
      number
    >;
    for (const row of this.db.all<{ type: DecisionEventType; n: number }>(
      'SELECT type, COUNT(*) AS n FROM decision_events WHERE decision_session_id = ? GROUP BY type',
      decisionSessionId,
    )) {
      counts[row.type] = row.n;
    }
    const room = this.db.get<{ participants: number; submitted: number; candidates: number }>(
      `SELECT
         (SELECT COUNT(*) FROM decision_participants WHERE decision_session_id = ?) AS participants,
         (SELECT COUNT(*) FROM decision_participants WHERE decision_session_id = ? AND submitted_at IS NOT NULL) AS submitted,
         (SELECT COUNT(*) FROM decision_candidates WHERE decision_session_id = ?) AS candidates`,
      decisionSessionId,
      decisionSessionId,
      decisionSessionId,
    )!;
    const fb = this.db.get<{ total: number; again: number | null; avg_fit: number | null }>(
      `SELECT COUNT(*) AS total, SUM(would_choose_again) AS again, AVG(fit_score) AS avg_fit
       FROM decision_feedback WHERE decision_session_id = ?`,
      decisionSessionId,
    )!;
    return {
      decision_session_id: decisionSessionId,
      counts,
      participants: room.participants,
      contexts_submitted: room.submitted,
      candidates: room.candidates,
      feedback: {
        total: fb.total,
        would_choose_again_rate: fb.total > 0 ? (fb.again ?? 0) / fb.total : null,
        avg_fit: fb.total > 0 ? fb.avg_fit : null,
      },
    };
  }
}
