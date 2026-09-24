import { describe, it, expect, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import { DecisionController } from '../../../src/nest/decision/decision.controller';
import type { DecisionService } from '../../../src/nest/decision/decision.service';
import { NotFoundError, ValidationError } from '../../../src/nest/common/domain-errors';
import type { User } from '../../../src/types';
import type { DecisionSession } from '@trek/shared';

const user = { id: 1 } as User;

const session = (over: Partial<DecisionSession> = {}): DecisionSession => ({
  id: 2,
  trip_id: 11,
  status: 'collecting',
  occasion: null,
  scheduled_at: null,
  travel_mode: 'driving',
  currency: 'VND',
  created_by_user_id: 1,
  created_at: '2026-09-24 08:00:00',
  updated_at: '2026-09-24 08:00:00',
  title: 'Tối nay đi đâu?',
  ...over,
});

function makeController(svc: Partial<DecisionService>) {
  return new DecisionController(svc as DecisionService);
}

function thrown(fn: () => unknown): { status: number; body: unknown } {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpException);
    const e = err as HttpException;
    return { status: e.getStatus(), body: e.getResponse() };
  }
  throw new Error('expected the handler to throw');
}

describe('DecisionController', () => {
  it('POST /api/decisions creates a session', () => {
    const create = vi.fn().mockReturnValue(session());
    const c = makeController({ create });
    const res = c.create(user, { title: 'Tối nay đi đâu?', occasion: 'hangout' } as never);
    expect(res.decision.id).toBe(2);
    expect(create).toHaveBeenCalledWith(1, { title: 'Tối nay đi đâu?', occasion: 'hangout' });
  });

  it('GET /api/decisions lists the caller sessions', () => {
    const list = vi.fn().mockReturnValue([session()]);
    const c = makeController({ list });
    expect(c.list(user).decisions).toHaveLength(1);
    expect(list).toHaveBeenCalledWith(1);
  });

  it('GET /api/decisions/:id is host-only (404 for non-owner)', () => {
    const c = makeController({ getForHost: vi.fn().mockReturnValue(undefined) });
    expect(thrown(() => c.get(user, '2'))).toEqual({ status: 404, body: { error: 'Decision not found' } });
  });

  it('GET /api/decisions/:id returns the session for its host', () => {
    const c = makeController({
      getForHost: vi.fn().mockReturnValue(session()),
      listRoster: vi.fn().mockReturnValue([{ id: 5, display_name: 'An', submitted_at: null }]),
      getSelection: vi.fn().mockReturnValue(undefined),
    });
    const res = c.get(user, '2');
    expect(res.decision.title).toBe('Tối nay đi đâu?');
    expect(res.participants).toHaveLength(1);
    expect(res.selection).toBeNull();
  });

  it('GET /api/decisions/:id includes the locked-in selection', () => {
    const selection = {
      id: 9,
      decision_session_id: 2,
      candidate_id: 5,
      recommendation_run_id: 7,
      selected_by_user_id: 1,
      selected_at: '2026-09-24 09:00:00',
    };
    const c = makeController({
      getForHost: vi.fn().mockReturnValue(session({ status: 'selected' })),
      listRoster: vi.fn().mockReturnValue([]),
      getSelection: vi.fn().mockReturnValue(selection),
    });
    expect(c.get(user, '2').selection?.candidate_id).toBe(5);
  });

  it('PATCH /api/decisions/:id rejects a bad id param before touching the service', () => {
    const c = makeController({ getForHost: vi.fn() });
    expect(thrown(() => c.update(user, 'x', {} as never)).status).toBe(400);
    expect(thrown(() => c.get(user, 'x')).status).toBe(400);
  });

  it('PATCH /api/decisions/:id maps ValidationError to 400 and NotFoundError to 404', () => {
    const update = vi.fn().mockImplementation(() => { throw new ValidationError('Cannot move decision'); });
    const c = makeController({ getForHost: vi.fn().mockReturnValue(session()), update });
    expect(thrown(() => c.update(user, '2', { status: 'resolved' } as never)).status).toBe(400);

    const update2 = vi.fn().mockImplementation(() => { throw new NotFoundError('Decision not found'); });
    const c2 = makeController({ getForHost: vi.fn().mockReturnValue(session()), update: update2 });
    expect(thrown(() => c2.update(user, '2', {} as never)).status).toBe(404);
  });
});
