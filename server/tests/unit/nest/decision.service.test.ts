import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { DecisionService } from '../../../src/nest/decision/decision.service';
import { DatabaseService } from '../../../src/nest/database/database.service';
import type { RealtimeService } from '../../../src/nest/realtime/realtime.service';
import { ValidationError, NotFoundError } from '../../../src/nest/common/domain-errors';
import { createTestDb, resetTestDb } from '../../helpers/test-db';

let testDb: Database.Database;
let svc: DecisionService;
const broadcast = vi.fn();

function seedUser(id = 1) {
  testDb.prepare('INSERT INTO users (id, username, email, password_hash) VALUES (?, ?, ?, ?)').run(id, `u${id}`, `u${id}@e.test`, 'x');
}

beforeEach(() => {
  testDb = createTestDb();
  resetTestDb(testDb);
  seedUser(1);
  broadcast.mockClear();
  const realtime = { broadcast } as unknown as RealtimeService;
  svc = new DecisionService(new DatabaseService(testDb), realtime);
});

describe('DecisionService', () => {
  it('creates a session with its technical trip in one transaction', () => {
    const s = svc.create(1, { title: 'Tối nay đi đâu?', occasion: 'hangout' });
    expect(s.status).toBe('collecting');
    expect(s.travel_mode).toBe('driving');
    expect(s.currency).toBe('VND');
    expect(s.title).toBe('Tối nay đi đâu?');
    // The technical trip exists, carrying the session 1:1.
    const trip = testDb.prepare('SELECT * FROM trips WHERE id = ?').get(s.trip_id) as Record<string, unknown>;
    expect(trip.user_id).toBe(1);
    expect(trip.title).toBe('Tối nay đi đâu?');
    expect(testDb.prepare('SELECT COUNT(*) n FROM decision_sessions WHERE trip_id = ?').get(s.trip_id)).toEqual({ n: 1 });
  });

  it('lists only the sessions a user hosts', () => {
    seedUser(2);
    svc.create(1, { title: 'Mine' });
    svc.create(2, { title: 'Theirs' });
    const mine = svc.list(1);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.title).toBe('Mine');
  });

  it('getForHost returns undefined for a non-owner instead of revealing the session', () => {
    seedUser(2);
    const s = svc.create(1, { title: 'Private' });
    expect(svc.getForHost(s.id, 1)?.id).toBe(s.id);
    expect(svc.getForHost(s.id, 2)).toBeUndefined();
  });

  it('PATCHes mutable fields, writing title back onto the technical trip', () => {
    const s = svc.create(1, { title: 'Old', occasion: 'a' });
    const u = svc.update(s.id, { title: 'New', occasion: 'b', travel_mode: 'walking' });
    expect(u.title).toBe('New');
    expect(u.occasion).toBe('b');
    expect(u.travel_mode).toBe('walking');
    expect((testDb.prepare('SELECT title FROM trips WHERE id = ?').get(s.trip_id) as Record<string, unknown>).title).toBe('New');
  });

  it('allows the documented host lifecycle moves and broadcasts status', () => {
    const s = svc.create(1, { title: 'X' });
    const ready = svc.update(s.id, { status: 'ready' });
    expect(ready.status).toBe('ready');
    expect(broadcast).toHaveBeenCalledWith(
      String(s.trip_id),
      'decision:status-updated',
      { decisionSessionId: s.id, status: 'ready' },
      undefined,
    );
  });

  it('rejects lifecycle jumps a host may not make directly', () => {
    const s = svc.create(1, { title: 'X' });
    // 'resolved' is earned by the resolver, never PATCHed.
    expect(() => svc.update(s.id, { status: 'resolved' })).toThrow(ValidationError);
    expect(() => svc.update(s.id, { status: 'resolving' })).toThrow(ValidationError);
    expect(() => svc.update(s.id, { status: 'selected' })).toThrow(ValidationError);
    // collecting -> closed is also not a move.
    expect(() => svc.update(s.id, { status: 'closed' })).toThrow(ValidationError);
  });

  it('treats canceled as terminal', () => {
    const s = svc.create(1, { title: 'X' });
    svc.update(s.id, { status: 'canceled' });
    expect(() => svc.update(s.id, { status: 'collecting' })).toThrow(ValidationError);
  });

  it('update throws NotFoundError for a missing session', () => {
    expect(() => svc.update(999, { title: 'x' })).toThrow(NotFoundError);
  });
});
