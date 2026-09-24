import { Injectable } from '@nestjs/common';
import type { DecisionEvent, DecisionEventType } from '@trek/shared';
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
}
