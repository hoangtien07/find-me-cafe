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

  describe('invite boundary', () => {
    it('createInvite returns the token once; the DB keeps only its SHA-256', () => {
      const s = svc.create(1, { title: 'X' });
      const { token, ...invite } = svc.createInvite(s.id, 1, 7);
      expect(token.length).toBeGreaterThan(20);
      const row = testDb.prepare('SELECT token_hash, expires_at FROM decision_invites WHERE id = ?').get(invite.id) as Record<string, unknown>;
      // SHA-256 hex, never the plaintext token.
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.token_hash).not.toBe(token);
      expect(row.expires_at).toBeTruthy();
    });

    it('previewInvite shows the outing without revealing participants', () => {
      const s = svc.create(1, { title: 'Tối nay đi đâu?', occasion: 'hangout' });
      const { token } = svc.createInvite(s.id, 1);
      const preview = svc.previewInvite(token)!;
      expect(preview.title).toBe('Tối nay đi đâu?');
      expect(preview.occasion).toBe('hangout');
      expect(preview.participant_count).toBe(0);
      expect('participants' in preview).toBe(false);
      expect(svc.previewInvite('bogus-token')).toBeUndefined();
    });

    it('joinByInvite mints a participant + scoped hashed token', () => {
      const s = svc.create(1, { title: 'X' });
      const { token } = svc.createInvite(s.id, 1);
      const joined = svc.joinByInvite(token, 'An')!;
      expect(joined.participant.display_name).toBe('An');
      expect(joined.participant_token).toBeTruthy();
      const ps = testDb.prepare('SELECT token_hash FROM decision_participant_sessions WHERE participant_id = ?').get(joined.participant.id) as Record<string, unknown>;
      expect(ps.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(ps.token_hash).not.toBe(joined.participant_token);
      // Broadcast on the technical trip's room.
      expect(broadcast).toHaveBeenCalledWith(String(s.trip_id), 'decision:participant-joined', { participant: expect.objectContaining({ id: joined.participant.id }) }, undefined);
    });

    it('joinByInvite applies an inline context', () => {
      const s = svc.create(1, { title: 'X' });
      const { token } = svc.createInvite(s.id, 1);
      const joined = svc.joinByInvite(token, 'An', {
        origin: { lat: 10.77, lng: 106.7, label: 'Q1' },
        max_travel_minutes: 30,
        budget_max: 100000,
        preferences: [{ key: 'drink', value: 'coffee' }],
        deal_breakers: [{ type: 'veto_category', value: { category: 'bar' } }],
      })!;
      const p = joined.participant;
      expect(p.origin_label).toBe('Q1');
      expect(p.max_travel_minutes).toBe(30);
      expect(p.submitted_at).toBeTruthy();
      expect(testDb.prepare('SELECT COUNT(*) n FROM decision_preferences WHERE participant_id = ?').get(p.id)).toEqual({ n: 1 });
      expect(testDb.prepare('SELECT is_hard FROM decision_constraints WHERE participant_id = ?').get(p.id)).toEqual({ is_hard: 1 });
    });

    it('joinByInvite refuses a join on a closed/expired invite or resolved session', () => {
      const s = svc.create(1, { title: 'X' });
      const { token } = svc.createInvite(s.id, 1);
      svc.update(s.id, { status: 'ready' });
      expect(svc.joinByInvite(token, 'An')).toBeTruthy();
      // Resolved sessions are not joinable.
      testDb.prepare("UPDATE decision_sessions SET status = 'resolved' WHERE id = ?").run(s.id);
      expect(svc.joinByInvite(token, 'B')).toBeUndefined();
      // Revoked invite is dead.
      testDb.prepare("UPDATE decision_invites SET revoked_at = CURRENT_TIMESTAMP").run();
      expect(svc.joinByInvite(token, 'C')).toBeUndefined();
    });
  });

  describe('participant surface', () => {
    const joinRoom = (title = 'X') => {
      const s = svc.create(1, { title });
      const { token } = svc.createInvite(s.id, 1);
      return { session: s, joined: svc.joinByInvite(token, 'An')! };
    };

    it('findParticipantByToken resolves a live participant and rejects bad/revoked tokens', () => {
      const { joined } = joinRoom();
      expect(svc.findParticipantByToken(joined.participant_token)?.id).toBe(joined.participant.id);
      expect(svc.findParticipantByToken('bogus')).toBeUndefined();
      testDb.prepare('UPDATE decision_participant_sessions SET revoked_at = CURRENT_TIMESTAMP').run();
      expect(svc.findParticipantByToken(joined.participant_token)).toBeUndefined();
    });

    it('participantSessionView shows the room + roster without others\' private context', () => {
      const { session, joined } = joinRoom('Tối nay đi đâu?');
      const view = svc.participantSessionView(joined.participant.id)!;
      expect(view.decision.title).toBe('Tối nay đi đâu?');
      expect(view.participants).toEqual([{ id: joined.participant.id, display_name: 'An', submitted_at: null }]);
      expect(view.preferences).toEqual([]);
      expect(view.deal_breakers).toEqual([]);
      void session;
    });

    it('updateParticipantContext persists the intake and broadcasts on the trip room', () => {
      const { session, joined } = joinRoom();
      const p = svc.updateParticipantContext(joined.participant.id, session.id, {
        origin: { lat: 10.77, lng: 106.7, label: 'Q1' },
        max_travel_minutes: 25,
        budget_min: 30000,
        budget_max: 80000,
        preferences: [
          { key: 'drink', value: 'coffee', weight: 2 },
          { key: 'vibe', value: 'quiet', is_hard: true },
        ],
        deal_breakers: [{ type: 'veto_category', value: { category: 'bar' } }],
      });
      expect(p.origin_label).toBe('Q1');
      expect(p.max_travel_minutes).toBe(25);
      expect(p.submitted_at).toBeTruthy();
      expect(broadcast).toHaveBeenCalledWith(
        String(session.trip_id),
        'decision:participant-updated',
        { participant: expect.objectContaining({ id: p.id }) },
        undefined,
      );
      const view = svc.participantSessionView(p.id)!;
      expect(view.preferences).toHaveLength(2);
      expect(view.preferences.find((x) => x.key === 'vibe')?.is_hard).toBe(true);
      expect(view.deal_breakers).toHaveLength(1);
      expect(view.deal_breakers[0]!.value).toEqual({ category: 'bar' });
    });

    it('re-submitting context replaces the preference/deal-breaker sets', () => {
      const { session, joined } = joinRoom();
      svc.updateParticipantContext(joined.participant.id, session.id, {
        preferences: [{ key: 'drink', value: 'coffee' }],
        deal_breakers: [{ type: 'veto_category', value: { category: 'bar' } }],
      });
      svc.updateParticipantContext(joined.participant.id, session.id, {
        preferences: [{ key: 'drink', value: 'matcha' }],
        deal_breakers: [],
      });
      const view = svc.participantSessionView(joined.participant.id)!;
      expect(view.preferences).toEqual([expect.objectContaining({ value: 'matcha' })]);
      expect(view.deal_breakers).toEqual([]);
    });
  });

  describe('candidates', () => {
    const addPlace = (tripId: number, name = 'Cà phê Vợt') => {
      const res = testDb
        .prepare(
          "INSERT INTO places (trip_id, name, lat, lng, address, price, currency) VALUES (?, ?, 10.77, 106.7, 'Q1', 45000, 'VND')",
        )
        .run(tripId, name);
      return Number(res.lastInsertRowid);
    };

    it('pins a trip place with a frozen evidence snapshot and broadcasts it', () => {
      const s = svc.create(1, { title: 'X' });
      const placeId = addPlace(s.trip_id);
      const c = svc.addCandidate(s.id, placeId, { type: 'host', id: 1 });
      expect(c.place_id).toBe(placeId);
      expect(c.added_by_type).toBe('host');
      expect(c.snapshot?.name).toBe('Cà phê Vợt');
      expect(c.snapshot?.price).toBe(45000);
      expect(broadcast).toHaveBeenCalledWith(
        String(s.trip_id),
        'decision:candidate-added',
        { candidate: expect.objectContaining({ id: c.id }) },
      );
      expect(svc.listCandidates(s.id)).toHaveLength(1);
    });

    it('the snapshot survives the place being edited afterwards', () => {
      const s = svc.create(1, { title: 'X' });
      const placeId = addPlace(s.trip_id);
      svc.addCandidate(s.id, placeId, { type: 'host', id: 1 });
      testDb.prepare("UPDATE places SET name = 'Đổi tên', price = 999 WHERE id = ?").run(placeId);
      expect(svc.listCandidates(s.id)[0]!.snapshot?.name).toBe('Cà phê Vợt');
    });

    it('rejects a place from another trip and a duplicate pin', () => {
      const s = svc.create(1, { title: 'X' });
      const s2 = svc.create(1, { title: 'Y' });
      const foreign = addPlace(s2.trip_id);
      expect(() => svc.addCandidate(s.id, foreign, { type: 'host', id: 1 })).toThrow(NotFoundError);
      const placeId = addPlace(s.trip_id);
      svc.addCandidate(s.id, placeId, { type: 'host', id: 1 });
      expect(() => svc.addCandidate(s.id, placeId, { type: 'host', id: 1 })).toThrow(ValidationError);
    });

    it('removes a candidate and broadcasts candidate-removed', () => {
      const s = svc.create(1, { title: 'X' });
      const c = svc.addCandidate(s.id, addPlace(s.trip_id), { type: 'host', id: 1 });
      svc.removeCandidate(s.id, c.id);
      expect(svc.listCandidates(s.id)).toHaveLength(0);
      expect(broadcast).toHaveBeenCalledWith(String(s.trip_id), 'decision:candidate-removed', {
        decisionSessionId: s.id,
        candidateId: c.id,
      });
      expect(() => svc.removeCandidate(s.id, c.id)).toThrow(NotFoundError);
    });
  });
});
