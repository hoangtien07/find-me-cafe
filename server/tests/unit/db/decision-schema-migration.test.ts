/**
 * Decision-domain schema (group-decision room). One migration creates the
 * whole table set: a session overlaid 1:1 on a technical trip (trip_id
 * UNIQUE), hashed-token invites and participant sessions, the participant
 * context (preferences/constraints), candidates, travel estimates, versioned
 * recommendation runs/scores, selection and feedback.
 */
import { runMigrations } from '../../../src/db/migrations';
import { createTables } from '../../../src/db/schema';

import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';

const DECISION_TABLES = [
  'decision_sessions',
  'decision_invites',
  'decision_participants',
  'decision_participant_sessions',
  'decision_preferences',
  'decision_constraints',
  'decision_candidates',
  'decision_travel_estimates',
  'recommendation_runs',
  'recommendation_scores',
  'decision_selections',
  'decision_feedback',
];

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  createTables(db);
  runMigrations(db);
  db.prepare("INSERT INTO users (id, username, email, password_hash) VALUES (1, 'u', 'u@example.test', 'x')").run();
  db.prepare("INSERT INTO trips (id, user_id, title, start_date, end_date) VALUES (1, 1, 'T', '2026-09-24', '2026-09-24')").run();
  return db;
}

const tableInfo = (db: Database.Database, table: string) =>
  db.prepare(`SELECT name, [notnull], dflt_value FROM pragma_table_info('${table}')`).all() as {
    name: string;
    notnull: number;
    dflt_value: string | null;
  }[];

const cols = (db: Database.Database, table: string) => new Set(tableInfo(db, table).map(c => c.name));

describe('decision schema migration', () => {
  it('MIG-DEC-001: creates the full decision table set', () => {
    const db = freshDb();
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
        t => t.name,
      ),
    );
    for (const t of DECISION_TABLES) expect(tables.has(t), `missing table ${t}`).toBe(true);
  });

  it('MIG-DEC-002: decision_sessions is a strict 1:1 overlay on the trip', () => {
    const db = freshDb();
    // One session per technical trip: a second insert hits UNIQUE(trip_id).
    db.prepare('INSERT INTO decision_sessions (trip_id, created_by_user_id) VALUES (1, 1)').run();
    expect(() =>
      db.prepare('INSERT INTO decision_sessions (trip_id, created_by_user_id) VALUES (1, 1)').run(),
    ).toThrow();
    // Lifecycle columns exist with the collecting default.
    const row = db.prepare('SELECT * FROM decision_sessions').get() as Record<string, unknown>;
    expect(row.status).toBe('collecting');
    expect(row.travel_mode).toBe('driving');
    expect(row.currency).toBe('VND');
  });

  it('MIG-DEC-003: invites and participant sessions store token hashes, never plaintext', () => {
    const db = freshDb();
    db.prepare('INSERT INTO decision_sessions (id, trip_id, created_by_user_id) VALUES (1, 1, 1)').run();
    expect(cols(db, 'decision_invites').has('token_hash')).toBe(true);
    expect(cols(db, 'decision_participant_sessions').has('token_hash')).toBe(true);
    // The hash must be unique so one token maps to exactly one row.
    db.prepare("INSERT INTO decision_invites (decision_session_id, token_hash, created_by_user_id) VALUES (1, 'h1', 1)").run();
    expect(() =>
      db.prepare("INSERT INTO decision_invites (decision_session_id, token_hash, created_by_user_id) VALUES (1, 'h1', 1)").run(),
    ).toThrow();
  });

  it('MIG-DEC-004: participant context rows cascade with their participant', () => {
    const db = freshDb();
    db.prepare('INSERT INTO decision_sessions (id, trip_id, created_by_user_id) VALUES (1, 1, 1)').run();
    db.prepare("INSERT INTO decision_participants (id, decision_session_id, display_name) VALUES (9, 1, 'An')").run();
    db.prepare("INSERT INTO decision_preferences (participant_id, key, value) VALUES (9, 'drink', 'coffee')").run();
    db.prepare("INSERT INTO decision_constraints (decision_session_id, participant_id, type) VALUES (1, 9, 'veto_category')").run();
    // Deleting the participant takes the preference and the constraint with it.
    db.prepare('DELETE FROM decision_participants WHERE id = 9').run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM decision_preferences').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM decision_constraints').get()).toEqual({ n: 0 });
  });

  it('MIG-DEC-005: a place can be a candidate only once per session', () => {
    const db = freshDb();
    db.prepare('INSERT INTO decision_sessions (id, trip_id, created_by_user_id) VALUES (1, 1, 1)').run();
    db.prepare("INSERT INTO places (id, trip_id, name) VALUES (7, 1, 'Cafe A')").run();
    db.prepare('INSERT INTO decision_candidates (decision_session_id, place_id) VALUES (1, 7)').run();
    expect(() =>
      db.prepare('INSERT INTO decision_candidates (decision_session_id, place_id) VALUES (1, 7)').run(),
    ).toThrow();
  });

  it('MIG-DEC-006: recommendation runs are versioned and scores rank inside a run', () => {
    const db = freshDb();
    db.prepare('INSERT INTO decision_sessions (id, trip_id, created_by_user_id) VALUES (1, 1, 1)').run();
    db.prepare("INSERT INTO places (id, trip_id, name) VALUES (7, 1, 'Cafe A')").run();
    db.prepare('INSERT INTO decision_candidates (id, decision_session_id, place_id) VALUES (3, 1, 7)').run();
    db.prepare("INSERT INTO recommendation_runs (id, decision_session_id, strategy_version) VALUES (5, 1, 'resolver-v1')").run();
    db.prepare('INSERT INTO recommendation_scores (recommendation_run_id, candidate_id, rank) VALUES (5, 3, 1)').run();
    const score = db.prepare('SELECT * FROM recommendation_scores').get() as Record<string, unknown>;
    expect(score.rank).toBe(1);
    expect(score.eligible).toBe(1);
  });

  it('MIG-DEC-007: selection is one-per-session and survives a deleted run link', () => {
    const db = freshDb();
    db.prepare('INSERT INTO decision_sessions (id, trip_id, created_by_user_id) VALUES (1, 1, 1)').run();
    db.prepare("INSERT INTO places (id, trip_id, name) VALUES (7, 1, 'Cafe A')").run();
    db.prepare('INSERT INTO decision_candidates (id, decision_session_id, place_id) VALUES (3, 1, 7)').run();
    db.prepare("INSERT INTO recommendation_runs (id, decision_session_id, strategy_version) VALUES (5, 1, 'resolver-v1')").run();
    db.prepare('INSERT INTO decision_selections (decision_session_id, candidate_id, recommendation_run_id, selected_by_user_id) VALUES (1, 3, 5, 1)').run();
    // One selection per session.
    expect(() =>
      db.prepare('INSERT INTO decision_selections (decision_session_id, candidate_id) VALUES (1, 3)').run(),
    ).toThrow();
    // The run link is SET NULL, so deleting a run keeps the selection row.
    db.prepare('DELETE FROM recommendation_runs WHERE id = 5').run();
    const sel = db.prepare('SELECT * FROM decision_selections').get() as Record<string, unknown>;
    expect(sel.recommendation_run_id).toBeNull();
    expect(sel.candidate_id).toBe(3);
  });

  it('MIG-DEC-008: backfills revoked_at on DBs that predate the column', () => {
    const db = freshDb();
    const { version } = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    // Simulate an install whose table was created before revoked_at existed:
    // old column set, version rewound to just before the backfill migration.
    db.exec('ALTER TABLE decision_participant_sessions DROP COLUMN revoked_at');
    db.prepare('UPDATE schema_version SET version = ?').run(version - 1);
    runMigrations(db);
    expect(cols(db, 'decision_participant_sessions').has('revoked_at')).toBe(true);
    expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version });
  });
});
