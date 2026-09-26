/**
 * Unit tests for the VIETMAP places provider and the provider selection it
 * plugs into (VMAP-xxx).
 *
 * The things that make VIETMAP different from Google and Amap, and that no
 * call-site care can fix: `search/v3`/`autocomplete/v3` return NO coordinates
 * (place/v3 supplies them, so search is a bounded fan-out), failures arrive as
 * real non-2xx statuses, and a ref_id has endpoint-specific shapes
 * (`vmg:POI:…`, `vm:ADDRESS:…`, `auto:…`) that all share the `vietmap:` prefix.
 *
 * fetch is stubbed; the SSRF guard and the database are mocked, the same way
 * maps.amap.test.ts does it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const { mockDbGet, mockDbRun, mockInstanceGet, mockProviderGet } = vi.hoisted(() => ({
  mockDbGet: vi.fn((..._args: unknown[]) => undefined as any),
  mockDbRun: vi.fn(),
  mockInstanceGet: vi.fn((..._args: unknown[]) => undefined as any),
  mockProviderGet: vi.fn((..._args: unknown[]) => undefined as any),
}));

vi.mock('../../../src/db/database', () => ({
  db: {
    prepare: (sql: string) => ({
      get: (...args: unknown[]) => {
        if (!sql.includes('app_settings')) return mockDbGet(...args);
        return args[0] === 'places_provider' ? mockProviderGet(...args) : mockInstanceGet(...args);
      },
      all: vi.fn(() => []),
      run: mockDbRun,
    }),
  },
}));

vi.mock('../../../src/utils/ssrfGuard', () => {
  class SsrfBlockedError extends Error {}
  return {
    SsrfBlockedError,
    checkSsrf: vi.fn(async () => ({ allowed: true })),
    safeFetchFollow: vi.fn(async (url: string, init?: any) => (globalThis.fetch as any)(url, init)),
  };
});

vi.mock('../../../src/nest/common/crypto/apiKeyCrypto', () => ({
  decrypt_api_key: (v: string | null) => v,
  maybe_encrypt_api_key: (v: string | null) => v,
}));

vi.mock('../../../src/config', () => ({ JWT_SECRET: 'test-secret', ENCRYPTION_KEY: '0'.repeat(64) }));

// Same reason as the amap suite: an index hit would end the test before the
// provider is exercised, and an unstubbed miss would call places.liketrek.com.
vi.mock('../../../src/nest/maps/trek-places.client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/nest/maps/trek-places.client')>()),
  trekPlacesSearch: vi.fn(async (): Promise<unknown[]> => []),
}));

import { db } from '../../../src/db/database';
import { DatabaseService } from '../../../src/nest/database/database.service';
import { MapsService } from '../../../src/nest/maps/maps.service';
import {
  VietmapPlacesProvider,
  isOutsideVietnam,
  isVietmapPlaceId,
  vietmapRefId,
} from '../../../src/nest/maps/providers/vietmap.provider';
import { isGooglePlaceId } from '../../../src/nest/maps/maps.helpers';
import type { PlacePhotoCacheService } from '../../../src/nest/place-photos/place-photo-cache.service';

const photoCacheStub = {
  get: vi.fn(() => null),
  getErrored: vi.fn(() => false),
  put: vi.fn(),
  markError: vi.fn(),
  getInFlight: vi.fn(() => undefined),
  setInFlight: vi.fn(),
  serveKey: vi.fn(() => null),
} as unknown as PlacePhotoCacheService;

const svc = new MapsService(new DatabaseService(db as never), photoCacheStub);

/** A provider over a fixed key, which is all these cases need. */
function provider(): VietmapPlacesProvider {
  return new VietmapPlacesProvider({ key: 'vietmap-test-key', source: 'operator-env', userId: 0 });
}

/** The URLs the stubbed calls were made with, in order. */
function calledUrls(): string[] {
  return (globalThis.fetch as any).mock.calls.map((c: unknown[]) => String(c[0]));
}
function calledUrl(): string {
  return calledUrls()[0];
}

/** search/v3 returns rows WITHOUT coordinates — that is the API's real shape. */
const SEARCH_ROWS = [
  { ref_id: 'vmg:POI:1', name: 'Cà Phê Vợt', address: '24 Phan Đình Phùng, Đà Lạt', distance: 120 },
  { ref_id: 'vmg:POI:2', name: 'Cộng Cà Phê', address: '26 Lý Tự Trọng, Quận 1', distance: 300 },
];

/** place/v3 supplies the coordinate a search row lacks. */
const DETAIL = { name: 'Cà Phê Vợt', display: '24 Phan Đình Phùng, Phường 1, Đà Lạt, Lâm Đồng', lat: 11.94, lng: 108.44 };

/** Stubs search/v3 then as many place/v3 lookups as asked. */
function stubSearch(placeDetails: (object | Error)[] = [DETAIL, DETAIL]) {
  const fetchSpy = vi.fn().mockResolvedValueOnce({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => SEARCH_ROWS,
  });
  for (const d of placeDetails) {
    if (d instanceof Error) fetchSpy.mockRejectedValueOnce(d);
    else fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => null }, json: async () => d });
  }
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

afterEach(() => {
  vi.unstubAllGlobals();
  mockDbGet.mockReset();
  mockDbGet.mockReturnValue(undefined);
  mockDbRun.mockReset();
  mockInstanceGet.mockReset();
  mockInstanceGet.mockReturnValue(undefined);
  mockProviderGet.mockReset();
  mockProviderGet.mockReturnValue(undefined);
});

// ── Place id namespace ───────────────────────────────────────────────────────

describe('VIETMAP place ids', () => {
  it('VMAP-001: namespaces a ref_id so it can never be sent to another provider', () => {
    expect(isVietmapPlaceId('vietmap:vmg:POI:123')).toBe(true);
    expect(vietmapRefId('vietmap:vmg:POI:123')).toBe('vmg:POI:123');
    // Like amap:, the prefix is load-bearing: a bare vmg ref could not be told
    // apart from an OSM type:id pair.
    expect(isGooglePlaceId('vietmap:vmg:POI:123')).toBe(false);
    expect(isVietmapPlaceId('node:240109189')).toBe(false);
    expect(isVietmapPlaceId('coords:10.7,106.7')).toBe(false);
    expect(vietmapRefId('ChIJ_____')).toBeNull();
  });
});

// ── isOutsideVietnam ─────────────────────────────────────────────────────────

describe('isOutsideVietnam', () => {
  it('VMAP-010: the coverage box holds mainland Vietnam and margin', () => {
    expect(isOutsideVietnam(10.78, 106.7)).toBe(false); // HCMC
    expect(isOutsideVietnam(21.03, 105.85)).toBe(false); // Hanoi
    expect(isOutsideVietnam(38.69, -9.21)).toBe(true); // Lisbon
    expect(isOutsideVietnam(39.9, 116.4)).toBe(true); // Beijing
  });
});

// ── searchText ───────────────────────────────────────────────────────────────

describe('VietmapPlacesProvider.searchText', () => {
  it('VMAP-020: hits search/v3, then resolves coordinates via place/v3 per row', async () => {
    const fetchSpy = stubSearch();
    const places = await provider().searchText('cà phê vợt');

    const urls = calledUrls();
    expect(urls[0]).toContain('/api/search/v3');
    expect(urls[0]).toContain('text=c%C3%A0+ph%C3%AA+v%E1%BB%A3t');
    expect(urls[1]).toContain('/api/place/v3');
    expect(urls[1]).toContain('refid=vmg%3APOI%3A1');
    // One search call + one place call per row, nothing else.
    expect(fetchSpy).toHaveBeenCalledTimes(1 + placeDetailCount());

    const [place] = places;
    expect(place.vietmap_ref_id).toBe('vietmap:vmg:POI:1');
    expect(place.lat).toBe(11.94);
    expect(place.lng).toBe(108.44);
    // place/v3's `display` is the full line — its own `address` field is often empty.
    expect(place.address).toBe('24 Phan Đình Phùng, Phường 1, Đà Lạt, Lâm Đồng');
    expect(place.source).toBe('vietmap');
  });

  function placeDetailCount() {
    return Math.min(SEARCH_ROWS.length, 5);
  }

  it('VMAP-021: a row whose coordinate lookup fails keeps its display fields', async () => {
    stubSearch([DETAIL, new Error('boom')]);
    const places = await provider().searchText('cà phê');
    expect(places).toHaveLength(2);
    expect(places[1].name).toBe('Cộng Cà Phê');
    expect(places[1].lat).toBeNull();
    expect(places[1].vietmap_ref_id).toBe('vietmap:vmg:POI:2');
  });

  it('VMAP-022: caps the coordinate fan-out — the tail ships without one', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ ref_id: `vmg:POI:${i}`, name: `Quán ${i}`, address: `Đường ${i}` }));
    const fetchSpy = vi.fn().mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => null }, json: async () => many });
    for (let i = 0; i < 5; i++) {
      fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ name: `Quán ${i}`, lat: 10, lng: 106 }) });
    }
    vi.stubGlobal('fetch', fetchSpy);

    const places = await provider().searchText('quán');
    expect(fetchSpy).toHaveBeenCalledTimes(6); // 1 search + 5 bounded lookups
    expect(places).toHaveLength(9);
    expect(places[8].lat).toBeNull();
    expect(places[8].name).toBe('Quán 8');
  });

  it('VMAP-023: a bias becomes focus + circle params', async () => {
    stubSearch([DETAIL, DETAIL]);
    await provider().searchText('cà phê', 'vi', { lat: 11.94, lng: 108.44, radius: 2000 });
    const url = calledUrl();
    expect(url).toContain('focus=11.94%2C108.44');
    expect(url).toContain('circle_radius=2000');
  });

  it('VMAP-024: a non-list answer resolves to [] instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ error: 'weird' }) }));
    await expect(provider().searchText('x')).resolves.toEqual([]);
  });
});

// ── Error translation ────────────────────────────────────────────────────────

describe('VIETMAP error handling', () => {
  it('VMAP-030: an invalid key surfaces as 403, quota as 429, the rest as 502', async () => {
    for (const [http, expected] of [[401, 403], [403, 403], [429, 429], [500, 502]] as const) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: http, headers: { get: () => null }, body: { cancel: vi.fn().mockResolvedValue(undefined) } }));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(provider().searchText('x')).rejects.toMatchObject({ status: expected });
      errorSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('VMAP-031: logs the key source and the user, never the key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, headers: { get: () => null }, body: { cancel: vi.fn().mockResolvedValue(undefined) } }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(provider().searchText('x')).rejects.toMatchObject({ status: 403 });
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('keySource=operator-env');
    expect(logged).not.toContain('vietmap-test-key');
    errorSpy.mockRestore();
  });
});

// ── autocomplete ─────────────────────────────────────────────────────────────

describe('VietmapPlacesProvider.autocomplete', () => {
  it('VMAP-040: namespaces every suggestion id and caps the list at five', async () => {
    const entries = Array.from({ length: 8 }, (_, i) => ({ ref_id: `auto:${i}`, name: `Quán ${i}`, address: `Đường ${i}` }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, headers: { get: () => null }, json: async () => entries }));

    const suggestions = await provider().autocomplete('quán');
    expect(suggestions).toHaveLength(5);
    expect(suggestions[0].placeId).toBe('vietmap:auto:0');
    expect(suggestions[0].mainText).toBe('Quán 0');
    expect(suggestions[0].secondaryText).toBe('Đường 0');
    expect(calledUrl()).toContain('/api/autocomplete/v3');
  });

  it('VMAP-041: drops a row with no ref_id, which cannot be looked up afterwards', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => [{ name: 'không ref' }, { ref_id: 'auto:9', name: 'Có ref', display: 'Đà Lạt' }],
      }),
    );
    const suggestions = await provider().autocomplete('quán');
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].placeId).toBe('vietmap:auto:9');
  });

  it('VMAP-042: biases around the centre of the viewport', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, headers: { get: () => null }, json: async () => [] }));
    await provider().autocomplete('quán', 'vi', { low: { lat: 10.7, lng: 106.6 }, high: { lat: 10.9, lng: 106.8 } });
    expect(calledUrl()).toContain('focus=10.800000%2C106.700000');
  });
});

// ── placeDetails ─────────────────────────────────────────────────────────────

describe('VietmapPlacesProvider.placeDetails', () => {
  it('VMAP-050: looks up the bare ref_id via place/v3', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, headers: { get: () => null }, json: async () => DETAIL }));
    const place = await provider().placeDetails('vietmap:vmg:POI:1');
    const url = calledUrl();
    expect(url).toContain('/api/place/v3');
    // The prefix is ours, not VIETMAP's — it must not reach the API.
    expect(new URL(url).searchParams.get('refid')).toBe('vmg:POI:1');
    expect(place!.name).toBe('Cà Phê Vợt');
    expect(place!.lat).toBe(11.94);
    expect(place!.vietmap_ref_id).toBe('vietmap:vmg:POI:1');
  });

  it('VMAP-051: returns null for an id that is not a VIETMAP id, without calling out', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await provider().placeDetails('ChIJsomething')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── reverse ──────────────────────────────────────────────────────────────────

describe('VietmapPlacesProvider.reverse', () => {
  it('VMAP-060: answers from reverse/v3 without a place/v3 hop', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => [{ name: 'Chợ Bến Thành', address: 'Quận 1, TP.HCM', lat: 10.772, lng: 106.698, ref_id: 'vmg:POI:9' }],
      }),
    );
    const answer = await provider().reverse(10.772, 106.698);
    expect(answer).toEqual({ name: 'Chợ Bến Thành', address: 'Quận 1, TP.HCM' });
    expect(calledUrl()).toContain('/api/reverse/v3');
    expect(calledUrl()).toContain('lat=10.772');
  });
});

// ── Provider selection ───────────────────────────────────────────────────────

/** The user row resolveApiKey reads, with both Google/Amap columns on it. */
type KeyRow = { maps_api_key: string | null; amap_api_key: string | null };

/**
 * Make each key chain answer or not. Google/Amap read the caller's user row
 * (mockDbGet) after env/instance; VIETMAP has no users column — its instance
 * row lands in mockInstanceGet like every other non-provider app_settings key.
 */
function keys(opts: { google?: string; amap?: string; vietmap?: string }) {
  mockDbGet.mockImplementation((..._args: unknown[]): KeyRow => ({
    maps_api_key: opts.google ?? null,
    amap_api_key: opts.amap ?? null,
  }));
  mockInstanceGet.mockImplementation((...args: unknown[]) =>
    args[0] === 'vietmap_api_key' && opts.vietmap ? { value: opts.vietmap } : undefined,
  );
}

describe('MapsService.keyedProvider with VIETMAP', () => {
  it('VMAP-070: auto keeps Google when a Google key is configured', () => {
    keys({ google: 'gkey', vietmap: 'vkey' });
    expect(svc.keyedProvider(1)).toMatchObject({ id: 'google', key: 'gkey' });
    expect(svc.resolvePlacesProvider(1)).toBeNull();
  });

  it('VMAP-071: auto falls through Amap to VIETMAP', () => {
    keys({ vietmap: 'vkey' });
    expect(svc.keyedProvider(1)?.id).toBe('vietmap');
    expect(svc.resolvePlacesProvider(1)).toBeInstanceOf(VietmapPlacesProvider);
  });

  it('VMAP-071b: Amap still wins over VIETMAP in auto', () => {
    keys({ amap: 'akey', vietmap: 'vkey' });
    expect(svc.keyedProvider(1)?.id).toBe('amap');
  });

  it('VMAP-072: auto with no key at all means the OpenStreetMap stack', () => {
    keys({});
    expect(svc.keyedProvider(1)).toBeNull();
    expect(svc.resolvePlacesProvider(1)).toBeNull();
  });

  it('VMAP-073: an explicit vietmap choice wins over a configured Google key', () => {
    mockProviderGet.mockReturnValue({ value: 'vietmap' });
    keys({ google: 'gkey', vietmap: 'vkey' });
    expect(svc.resolvePlacesProvider(1)).toBeInstanceOf(VietmapPlacesProvider);
  });

  it('VMAP-074: an explicit vietmap with no key answers OpenStreetMap, not Google', () => {
    mockProviderGet.mockReturnValue({ value: 'vietmap' });
    keys({ google: 'gkey' });
    // Misconfigured means "answer with OSM", not "bill somebody else's provider".
    expect(svc.keyedProvider(1)).toBeNull();
  });

  it('VMAP-075: an explicit google never silently uses VIETMAP instead', () => {
    mockProviderGet.mockReturnValue({ value: 'google' });
    keys({ vietmap: 'vkey' });
    expect(svc.keyedProvider(1)).toBeNull();
  });

  it('VMAP-076: a VIETMAP place stays with VIETMAP even while Google is selected', async () => {
    mockProviderGet.mockReturnValue({ value: 'google' });
    keys({ google: 'gkey', vietmap: 'vkey' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, headers: { get: () => null }, json: async () => DETAIL }),
    );

    const { place } = await svc.getPlaceDetails(1, 'vietmap:vmg:POI:1');
    // Reached VIETMAP's endpoint, not Google's — an id outlives the setting.
    expect(calledUrl()).toContain('maps.vietmap.vn');
    expect(place!.name).toBe('Cà Phê Vợt');
  });

  it('VMAP-077: a vietmap id is never mistaken for an OSM type:id pair', async () => {
    // `vietmap:vmg:POI:1` contains colons, like `node:123`. Read as OSM it
    // would go to Overpass as element type "vietmap" — the ordering of those
    // two branches is load-bearing.
    mockProviderGet.mockReturnValue({ value: 'vietmap' });
    keys({ vietmap: 'vkey' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, headers: { get: () => null }, json: async () => DETAIL }),
    );
    const { place } = await svc.getPlaceDetails(1, 'vietmap:vmg:POI:1');
    expect(place!.source).toBe('vietmap');
    expect(calledUrl()).not.toContain('overpass');
  });
});

describe('MapsService with VIETMAP in the keyed slot', () => {
  let indexSpy: { mockRestore: () => void } | null = null;
  afterEach(() => {
    indexSpy?.mockRestore();
    indexSpy = null;
  });
  function vietmapSelected() {
    indexSpy = vi.spyOn(svc, 'trekPlacesEnabled').mockReturnValue(false);
    mockProviderGet.mockReturnValue({ value: 'vietmap' });
    keys({ vietmap: 'vkey' });
  }

  it('VMAP-080: search reports vietmap as the source', async () => {
    vietmapSelected();
    stubSearch([DETAIL, DETAIL]);
    const result = await svc.searchPlaces(1, 'cà phê');
    expect(result.source).toBe('vietmap');
    expect(result.places[0].vietmap_ref_id).toBe('vietmap:vmg:POI:1');
  });

  it('VMAP-081: a point outside the VIETMAP box goes straight to Nominatim', async () => {
    // Lisbon. VIETMAP holds the slot, but it knows nothing out here — same
    // skip the Amap box gives the China provider.
    mockProviderGet.mockReturnValue({ value: 'vietmap' });
    mockInstanceGet.mockImplementation((...args: unknown[]) =>
      args[0] === 'vietmap_api_key' ? { value: 'vkey' } : undefined,
    );
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ name: 'Belém', display_name: 'Lisboa' }) });
    vi.stubGlobal('fetch', fetchSpy);

    const answer = await svc.reverseGeocode('38.6916', '-9.2160');
    expect(answer).toEqual({ name: 'Belém', address: 'Lisboa' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain('nominatim');
  });
});
