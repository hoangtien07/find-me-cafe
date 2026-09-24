import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb, resetTestDb } from '../../helpers/test-db';
import { DatabaseService } from '../../../src/nest/database/database.service';
import { DecisionService } from '../../../src/nest/decision/decision.service';
import { TravelMatrixService } from '../../../src/nest/decision/travel/travel-matrix.service';
import { MockTravelMatrixProvider } from '../../../src/nest/decision/travel/mock-travel-matrix.provider';
import { DecisionResolverService } from '../../../src/nest/decision/resolver/resolver.service';
import type { RealtimeService } from '../../../src/nest/realtime/realtime.service';

/**
 * VS-08 — the resolver pipeline end to end: real mock matrix, real persisted
 * estimates, constraint engine, fairness, ranking, Top-3 evidence rows.
 */
describe('DecisionResolverService', () => {
  let testDb: Database.Database;
  let decisions: DecisionService;
  let resolver: DecisionResolverService;
  const broadcast = vi.fn();

  beforeEach(() => {
    testDb = createTestDb();
    resetTestDb(testDb);
    broadcast.mockClear();
    testDb.prepare('INSERT INTO users (id, username, email, password_hash) VALUES (1, ?, ?, ?)').run('host', 'h@t.dev', 'x');
    const db = new DatabaseService(testDb);
    const realtime = { broadcast } as unknown as RealtimeService;
    decisions = new DecisionService(db, realtime);
    resolver = new DecisionResolverService(db, realtime, decisions, new TravelMatrixService(db, new MockTravelMatrixProvider()));
  });

  const joinWithOrigin = (sessionId: number, name: string, lat: number, lng: number, maxMin: number | null = null) => {
    const { token } = decisions.createInvite(sessionId, 1);
    const { participant } = decisions.joinByInvite(token, name)!;
    decisions.updateParticipantContext(participant.id, sessionId, {
      origin: { lat, lng, label: name },
      max_travel_minutes: maxMin ?? undefined,
    });
    return participant;
  };

  const addPlace = (tripId: number, name: string, lat: number, lng: number, price: number | null = null) => {
    const res = testDb
      .prepare('INSERT INTO places (trip_id, name, lat, lng, price) VALUES (?, ?, ?, ?, ?)')
      .run(tripId, name, lat, lng, price);
    return Number(res.lastInsertRowid);
  };

  it('runs the full pipeline: constraints → matrix → fairness → ranked Top-N with evidence', async () => {
    const s = decisions.create(1, { title: 'Chốt quán' });
    // Three equidistant-ish candidates near the participants.
    for (const [i, name] of ['A', 'B', 'C'].entries()) {
      decisions.addCandidate(s.id, addPlace(s.trip_id, `Quán ${name}`, 10.77 + i * 0.005, 106.7), { type: 'host', id: 1 });
    }
    joinWithOrigin(s.id, 'An', 10.77, 106.69, 60);
    joinWithOrigin(s.id, 'Bình', 10.78, 106.71, 60);

    const result = await resolver.resolve(s.id);
    expect(result.run.strategy_version).toBe('resolver-v1');
    expect(result.run.status).toBe('completed');
    expect(result.items).toHaveLength(3);
    expect(result.items[0]!.rank).toBe(1);
    expect(result.items[0]!.eligible).toBe(true);
    expect(result.items[0]!.explanation?.travel_times).toHaveLength(2);
    // The session flipped to resolved and the room heard it.
    expect(decisions.getSession(s.id)!.status).toBe('resolved');
    expect(broadcast).toHaveBeenCalledWith(String(s.trip_id), 'decision:recommendation-ready', {
      decisionSessionId: s.id,
      runId: result.run.id,
    });
    expect(broadcast).toHaveBeenCalledWith(String(s.trip_id), 'decision:status-updated', {
      decisionSessionId: s.id,
      status: 'resolved',
    });
  });

  it('an explicit veto makes a candidate ineligible — and the row explains why', async () => {
    const s = decisions.create(1, { title: 'X' });
    const catId = Number(testDb.prepare("INSERT INTO categories (name) VALUES ('bar')").run().lastInsertRowid);
    const barPlace = addPlace(s.trip_id, 'Bar X', 10.775, 106.7);
    testDb.prepare('UPDATE places SET category_id = ? WHERE id = ?').run(catId, barPlace);
    const cafePlace = addPlace(s.trip_id, 'Cafe Y', 10.775, 106.7);
    decisions.addCandidate(s.id, barPlace, { type: 'host', id: 1 });
    decisions.addCandidate(s.id, cafePlace, { type: 'host', id: 1 });
    const { token } = decisions.createInvite(s.id, 1);
    const { participant } = decisions.joinByInvite(token, 'An')!;
    decisions.updateParticipantContext(participant.id, s.id, {
      origin: { lat: 10.77, lng: 106.7 },
      deal_breakers: [{ type: 'veto_category', value: { category: 'bar' } }],
    });

    const result = await resolver.resolve(s.id);
    const bar = result.items.find((i) => i.candidate.snapshot?.name === 'Bar X')!;
    const cafe = result.items.find((i) => i.candidate.snapshot?.name === 'Cafe Y')!;
    expect(bar.eligible).toBe(false);
    expect(bar.constraint_result?.violations[0]?.type).toBe('veto_category');
    expect(cafe.eligible).toBe(true);
    expect(cafe.rank).toBe(1);
  });

  it('UNKNOWN is not PASS: a missing origin leaves travel unverifiable but visible', async () => {
    const s = decisions.create(1, { title: 'X', scheduled_at: '2026-10-01T19:00:00Z' });
    decisions.addCandidate(s.id, addPlace(s.trip_id, 'Cafe', 10.775, 106.7), { type: 'host', id: 1 });
    const { token } = decisions.createInvite(s.id, 1);
    const { participant } = decisions.joinByInvite(token, 'An')!;
    // Submits a hard travel cap but no origin → the cap can't be checked.
    decisions.updateParticipantContext(participant.id, s.id, { max_travel_minutes: 20 });

    const result = await resolver.resolve(s.id);
    const item = result.items[0]!;
    expect(item.eligible).toBe(true); // no violations
    const types = item.constraint_result?.unknowns.map((u) => u.type) ?? [];
    expect(types).toContain('max_travel');
    expect(types).toContain('opening_hours'); // scheduled but no hours evidence
  });

  it('a participant over their hard travel cap marks the candidate ineligible', async () => {
    const s = decisions.create(1, { title: 'X' });
    decisions.addCandidate(s.id, addPlace(s.trip_id, 'Cafe xa', 11.5, 107.5), { type: 'host', id: 1 });
    joinWithOrigin(s.id, 'An', 10.77, 106.7, 15); // 15-min hard cap, venue is far

    const result = await resolver.resolve(s.id);
    expect(result.items[0]!.eligible).toBe(false);
    expect(result.items[0]!.constraint_result?.violations[0]?.type).toBe('max_travel');
  });

  it('re-resolving writes a new versioned run, never overwrites history', async () => {
    const s = decisions.create(1, { title: 'X' });
    decisions.addCandidate(s.id, addPlace(s.trip_id, 'Cafe', 10.775, 106.7), { type: 'host', id: 1 });
    joinWithOrigin(s.id, 'An', 10.77, 106.69);
    const r1 = await resolver.resolve(s.id);
    const r2 = await resolver.resolve(s.id);
    expect(r2.run.id).not.toBe(r1.run.id);
    expect(
      testDb.prepare("SELECT COUNT(*) n FROM recommendation_runs WHERE decision_session_id = ? AND status = 'completed'").get(s.id),
    ).toEqual({ n: 2 });
    // Same inputs → same input_hash.
    expect(r2.run.input_hash).toBe(r1.run.input_hash);
  });

  it('refuses to resolve with no candidates or no participants', async () => {
    const s = decisions.create(1, { title: 'X' });
    await expect(resolver.resolve(s.id)).rejects.toThrow('No candidates');
    decisions.addCandidate(s.id, addPlace(s.trip_id, 'Cafe', 10.775, 106.7), { type: 'host', id: 1 });
    await expect(resolver.resolve(s.id)).rejects.toThrow('No participants');
  });
});
