import { describe, it, expect, beforeEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { createTestDb, resetTestDb } from '../../helpers/test-db';
import { DatabaseService } from '../../../src/nest/database/database.service';
import { TravelMatrixService } from '../../../src/nest/decision/travel/travel-matrix.service';
import { MockTravelMatrixProvider } from '../../../src/nest/decision/travel/mock-travel-matrix.provider';
import type { TravelMatrixProvider } from '../../../src/nest/decision/travel/travel-matrix.provider';

/**
 * VS-07 — the travel matrix service + deterministic mock provider.
 * Covers every matrix shape the plan requires: missing origin, missing
 * destination coordinates, partial matrix (no_route), provider error, and
 * fixture determinism.
 */
describe('TravelMatrixService + MockTravelMatrixProvider', () => {
  let testDb: Database;
  let db: DatabaseService;
  let matrix: TravelMatrixService;

  beforeEach(() => {
    testDb = createTestDb();
    resetTestDb(testDb);
    db = new DatabaseService(testDb);
    matrix = new TravelMatrixService(db, new MockTravelMatrixProvider());
    testDb.prepare('INSERT INTO users (id, username, email, password_hash) VALUES (1, ?, ?, ?)').run('host', 'h@t.dev', 'x');
    testDb.prepare('INSERT INTO trips (id, user_id, title) VALUES (10, 1, ?)').run('T');
    testDb
      .prepare("INSERT INTO decision_sessions (id, trip_id, travel_mode, created_by_user_id) VALUES (5, 10, 'driving', 1)")
      .run();
  });

  const addParticipant = (id: number, lat: number | null, lng: number | null) =>
    testDb
      .prepare('INSERT INTO decision_participants (id, decision_session_id, display_name, origin_lat, origin_lng) VALUES (?, 5, ?, ?, ?)')
      .run(id, `P${id}`, lat, lng);

  const addCandidate = (id: number, lat: number | null, lng: number | null) => {
    const placeId = Number(
      testDb.prepare("INSERT INTO places (trip_id, name) VALUES (10, ?)").run(`place-${id}`).lastInsertRowid,
    );
    testDb
      .prepare(
        "INSERT INTO decision_candidates (id, decision_session_id, place_id, source, added_by_type, snapshot_json) VALUES (?, 5, ?, 'manual', 'host', ?)",
      )
      .run(id, placeId, JSON.stringify({ name: `C${id}`, lat, lng }));
  };

  it('deterministic: same coordinates produce the same numbers on every run', async () => {
    addParticipant(1, 10.77, 106.7);
    addCandidate(1, 10.78, 106.71);
    const a = await matrix.computeSessionMatrix(5, 'driving');
    const b = await matrix.computeSessionMatrix(5, 'driving', true); // force recompute
    expect(a[0]!.status).toBe('ok');
    expect(b[0]!.duration_seconds).toBe(a[0]!.duration_seconds);
    expect(b[0]!.distance_meters).toBe(a[0]!.distance_meters);
    expect(a[0]!.provider).toBe('mock');
  });

  it('participant missing origin → explicit missing_origin cell, not a hole', async () => {
    addParticipant(1, null, null);
    addCandidate(1, 10.78, 106.71);
    const rows = await matrix.computeSessionMatrix(5, 'driving');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('missing_origin');
    expect(rows[0]!.duration_seconds).toBeNull();
  });

  it('candidate missing coordinates → missing_destination cell', async () => {
    addParticipant(1, 10.77, 106.7);
    addCandidate(1, null, null);
    const rows = await matrix.computeSessionMatrix(5, 'driving');
    expect(rows[0]!.status).toBe('missing_destination');
  });

  it('partial matrix: a (0,0) coordinate yields a no_route cell while siblings compute', async () => {
    addParticipant(1, 10.77, 106.7);
    addCandidate(1, 10.78, 106.71); // routable
    addCandidate(2, 0, 0); // mock fixture: unroutable
    const rows = await matrix.computeSessionMatrix(5, 'driving');
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.candidate_id === 1)!.status).toBe('ok');
    expect(rows.find((r) => r.candidate_id === 2)!.status).toBe('no_route');
  });

  it('provider error marks cells error rather than losing them silently', async () => {
    const broken: TravelMatrixProvider = { compute: async () => Promise.reject(new Error('vendor down')) };
    const m = new TravelMatrixService(db, broken);
    addParticipant(1, 10.77, 106.7);
    addCandidate(1, 10.78, 106.71);
    const rows = await m.computeSessionMatrix(5, 'driving');
    expect(rows[0]!.status).toBe('error');
    expect(rows[0]!.duration_seconds).toBeNull();
  });

  it('cache: fresh rows are not recomputed; stale/force are', async () => {
    addParticipant(1, 10.77, 106.7);
    addCandidate(1, 10.78, 106.71);
    await matrix.computeSessionMatrix(5, 'driving');
    // Make the row deterministically recognizable; a cached second call keeps it.
    testDb.prepare("UPDATE decision_travel_estimates SET provider = 'cached-marker' WHERE decision_session_id = 5").run();
    const cached = await matrix.computeSessionMatrix(5, 'driving');
    expect(cached[0]!.provider).toBe('cached-marker');
    const recomputed = await matrix.computeSessionMatrix(5, 'driving', true);
    expect(recomputed[0]!.provider).toBe('mock');
  });
});
