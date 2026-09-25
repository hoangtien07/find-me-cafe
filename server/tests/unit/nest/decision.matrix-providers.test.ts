import { describe, it, expect, vi, afterEach } from 'vitest';
import { GoogleRoutesMatrixProvider } from '../../../src/nest/decision/travel/google-routes.provider';
import { OsrmTableMatrixProvider } from '../../../src/nest/decision/travel/osrm-table.provider';
import { MockTravelMatrixProvider } from '../../../src/nest/decision/travel/mock-travel-matrix.provider';
import { deriveDecision } from '../../../src/app-config/derive';
import { selectMatrixProvider } from '../../../src/nest/decision/travel/matrix-provider-select';
import type { TravelMatrixInput } from '../../../src/nest/decision/travel/travel-matrix.provider';

/**
 * M2-05 — the real matrix adapters behind TRAVEL_MATRIX_PROVIDER: request
 * shape (key header, minimal field mask, mode map), response boundary
 * validation, explicit per-cell errors, and the env-selection contract
 * (fail closed on a missing key, mock stays selectable).
 */

const origins = [{ lat: 10.77, lng: 106.7 }, { lat: 10.78, lng: 106.68 }];
const destinations = [{ lat: 10.79, lng: 106.69 }];
const input = (mode: TravelMatrixInput['mode'] = 'driving'): TravelMatrixInput => ({ origins, destinations, mode });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GoogleRoutesMatrixProvider', () => {
  it('posts computeRouteMatrix with the key, the minimal field mask and the mode map', async () => {
    const seen: { url?: string; headers?: Record<string, string>; body?: string } = {};
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      seen.url = url;
      seen.headers = init.headers as Record<string, string>;
      seen.body = init.body as string;
      return new Response('[]', { status: 200 });
    }));
    const p = new GoogleRoutesMatrixProvider('KEY', 'https://routes.example.test', 5000);
    await p.compute(input('cycling'));
    expect(seen.url).toBe('https://routes.example.test/distanceMatrix/v2:computeRouteMatrix');
    expect(seen.headers?.['X-Goog-Api-Key']).toBe('KEY');
    expect(seen.headers?.['X-Goog-FieldMask']).toBe('originIndex,destinationIndex,condition,status,distanceMeters,duration');
    const body = JSON.parse(seen.body ?? '{}') as { travelMode: string; origins: unknown[]; destinations: unknown[] };
    expect(body.travelMode).toBe('TWO_WHEELER'); // the VN motorbike mode
    expect(body.origins).toHaveLength(2);
    expect(body.destinations).toHaveLength(1);
  });

  it('maps ROUTE_EXISTS cells to ok with parsed duration, NO_ROUTE_FOUND to no_route, errors to error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify([
        { originIndex: 0, destinationIndex: 0, condition: 'ROUTE_EXISTS', distanceMeters: 1234.6, duration: '900s' },
        { originIndex: 1, destinationIndex: 0, condition: 'NO_ROUTE_FOUND' },
      ]), { status: 200 }),
    ));
    const p = new GoogleRoutesMatrixProvider('KEY');
    const { cells, provider } = await p.compute(input());
    expect(provider).toBe('google');
    expect(cells).toHaveLength(2);
    expect(cells[0]).toMatchObject({ status: 'ok', distanceMeters: 1235, durationSeconds: 900 });
    expect(cells[1]).toMatchObject({ status: 'no_route', distanceMeters: null, durationSeconds: null });
  });

  it('a missing element or a status object becomes an explicit error cell, never a hole', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify([
        { originIndex: 0, destinationIndex: 0, condition: 'ROUTE_EXISTS', distanceMeters: 100, duration: '60s' },
        { originIndex: 1, destinationIndex: 0, status: { code: 3, message: 'bad waypoint' } },
      ]), { status: 200 }),
    ));
    const p = new GoogleRoutesMatrixProvider('KEY');
    const { cells } = await p.compute(input());
    expect(cells[1]!.status).toBe('error');
  });

  it('a non-200 upstream or an oversized request throws (service marks cells error)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 429 })));
    const p = new GoogleRoutesMatrixProvider('KEY');
    await expect(p.compute(input())).rejects.toThrow(/429/);
    const huge: TravelMatrixInput = {
      origins: Array.from({ length: 30 }, (_, i) => ({ lat: i, lng: i })),
      destinations: Array.from({ length: 30 }, (_, i) => ({ lat: i, lng: i })),
      mode: 'driving',
    };
    await expect(p.compute(huge)).rejects.toThrow(/exceeds/);
  });
});

describe('OsrmTableMatrixProvider', () => {
  it('requests duration+distance with sources/destinations index lists', async () => {
    const seen: { url?: string } = {};
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      seen.url = url;
      return new Response(JSON.stringify({ code: 'Ok', durations: [[120]], distances: [[1500]] }), { status: 200 });
    }));
    const p = new OsrmTableMatrixProvider('https://osrm.test');
    await p.compute({ origins: [origins[0]!], destinations, mode: 'driving' });
    expect(seen.url).toContain('/table/v1/driving/');
    expect(seen.url).toContain('annotations=duration,distance');
    expect(seen.url).toContain('sources=0');
    expect(seen.url).toContain('destinations=1');
  });

  it('null durations become no_route cells', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ code: 'Ok', durations: [[120, null]], distances: [[1500, null]] }), { status: 200 }),
    ));
    const p = new OsrmTableMatrixProvider();
    const { cells } = await p.compute({ origins: [origins[0]!], destinations: [...destinations, destinations[0]!], mode: 'driving' });
    expect(cells[0]!.status).toBe('ok');
    expect(cells[1]!.status).toBe('no_route');
  });

  it('transit has no OSRM profile — the call fails rather than faking a car', async () => {
    const p = new OsrmTableMatrixProvider();
    await expect(p.compute(input('transit'))).rejects.toThrow(/no profile/);
  });
});

describe('selectMatrixProvider', () => {
  it('mock is the default and stays explicitly selectable', () => {
    expect(selectMatrixProvider(deriveDecision({}))).toBeInstanceOf(MockTravelMatrixProvider);
    expect(selectMatrixProvider(deriveDecision({ DECISION_MATRIX_PROVIDER: 'mock' }))).toBeInstanceOf(
      MockTravelMatrixProvider,
    );
  });

  it('google without a key refuses — never a silent mock fallback', () => {
    expect(() => selectMatrixProvider(deriveDecision({ DECISION_MATRIX_PROVIDER: 'google' }))).toThrow(
      /GOOGLE_ROUTES_API_KEY/,
    );
    expect(
      selectMatrixProvider(deriveDecision({ DECISION_MATRIX_PROVIDER: 'google', GOOGLE_ROUTES_API_KEY: 'k' })),
    ).toBeInstanceOf(GoogleRoutesMatrixProvider);
  });

  it('osrm selects the table adapter; unknown names refuse', () => {
    expect(selectMatrixProvider(deriveDecision({ DECISION_MATRIX_PROVIDER: 'osrm' }))).toBeInstanceOf(
      OsrmTableMatrixProvider,
    );
    expect(() => selectMatrixProvider(deriveDecision({ DECISION_MATRIX_PROVIDER: 'magic' }))).toThrow(/unknown/);
  });
});
