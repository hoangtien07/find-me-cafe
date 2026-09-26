/**
 * VIETMAP as a PlacesProvider — the Vietnamese-market keyed provider.
 *
 * Why this exists: OpenStreetMap coverage of Vietnamese POIs is thin (small
 * cafés, ward-level addressing, diacritics-heavy names), and Google Places is
 * the expensive incumbent. VIETMAP's POI index is Vietnam-native, so a VN
 * install gets local-quality search without a Google bill.
 *
 * Shape notes, all verified against the live API (see
 * https://maps.vietmap.vn/docs/map-api/):
 *
 *  1. **Two-step coordinates.** `search/v3` and `autocomplete/v3` return a
 *     `ref_id` + display fields but NO `lat`/`lng`; coordinates come from
 *     `place/v3?refid=`. searchText therefore fans out one place call per
 *     result, bounded to a small page.
 *
 *  2. **Errors.** Failures arrive as non-2xx (401/403 for a bad key, 429 over
 *     quota); a 200 body is the result array itself. Thrown errors carry the
 *     same `Error & { status }` the Google path produces so the controller's
 *     mapping reports a credential problem instead of an empty result.
 *
 *  3. **ref_id formats vary by endpoint** (`vmg:POI:…`, `vm:ADDRESS:…`,
 *     `auto:…`). Every one is wrapped in the `vietmap:` prefix so a stored
 *     place id routes back to this provider for details, the same way
 *     `amap:` does.
 */
import { readEnv } from '../../../app-config';
import { safeFetchFollow } from '../../../utils/ssrfGuard';
import { discardBody, exceedsDeclaredLength, readCappedJson } from '../../../utils/cappedFetch';
import { UA } from '../maps.helpers';
import type {
  PlacesProvider,
  ProviderCredential,
  ProviderPlace,
  ProviderSuggestion,
  SearchBias,
  ViewportBias,
} from './places-provider';

/** The upstream every call is written against; VIETMAP_API_BASE overrides for a gateway. */
const VIETMAP_UPSTREAM = 'https://maps.vietmap.vn';
/** A search answer is a few dozen entries; anything past this is not the endpoint we think it is. */
const VIETMAP_MAX_RESPONSE_BYTES = 1_000_000;
/** searchText resolves coordinates via place/v3 per row — bounded so one query is one bounded fan-out. */
const SEARCH_COORD_LOOKUPS = 5;

/** `vietmap:` prefix — makes a VIETMAP ref_id recognisable anywhere in TREK. */
export const VIETMAP_PLACE_ID_PREFIX = 'vietmap:';
export const VIETMAP_PLACE_ID = /^vietmap:(.+)$/i;

export function isVietmapPlaceId(placeId: string): boolean {
  return VIETMAP_PLACE_ID.test(placeId);
}

/**
 * VIETMAP's coverage box — mainland Vietnam plus margin (≈ lat 8–24,
 * lng 102–110). A point outside it cannot produce a VIETMAP answer, so
 * reverse-geocode callers skip the round trip rather than paying it to learn
 * nothing. Same role `isOutsideChina` plays for Amap.
 */
export function isOutsideVietnam(lat: number, lng: number): boolean {
  return lat < 8 || lat > 24 || lng < 102 || lng > 110;
}

/** The bare ref_id, or null when this is not a VIETMAP place. */
export function vietmapRefId(placeId: string): string | null {
  const m = VIETMAP_PLACE_ID.exec(placeId);
  return m ? m[1] : null;
}

interface VietmapEntry {
  ref_id?: string;
  distance?: number;
  address?: string;
  name?: string;
  display?: string;
  lat?: number;
  lng?: number;
}

interface VietmapPlaceDetail {
  display?: string;
  name?: string;
  hs_num?: string;
  street?: string;
  address?: string;
  city?: string;
  district?: string;
  ward?: string;
  lat?: number;
  lng?: number;
}

function vietmapText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The full address a place detail splits into parts: `display` when present,
 * then the flat `address` field, then street + ward + district + city
 * composed. `display` carries the whole line when it exists, but some rows
 * only populate `address`.
 */
function vietmapAddress(detail: VietmapPlaceDetail): string {
  const display = vietmapText(detail.display);
  if (display) return display;
  const address = vietmapText(detail.address);
  if (address) return address;
  const street = [vietmapText(detail.hs_num), vietmapText(detail.street)].filter(Boolean).join(' ');
  return [street, vietmapText(detail.ward), vietmapText(detail.district), vietmapText(detail.city)]
    .filter(Boolean)
    .join(', ');
}

/** Boundary shape check: a non-object row carries no ref_id or coordinates. */
function isVietmapEntry(value: unknown): value is VietmapEntry {
  return typeof value === 'object' && value !== null;
}

/** Boundary coercion: a coordinate that isn't a finite number isn't a coordinate. */
function vietmapNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export class VietmapPlacesProvider implements PlacesProvider {
  readonly id = 'vietmap' as const;

  constructor(private readonly credential: ProviderCredential) {}

  private url(path: string, params: Record<string, string>): string {
    const query = new URLSearchParams({ ...params, apikey: this.credential.key });
    const base = (readEnv().decision.vietmapApiBase || VIETMAP_UPSTREAM).replace(/([^/]|^)\/+$/, '$1');
    return `${base}${path}?${query.toString()}`;
  }

  /**
   * One call. Through safeFetchFollow like every outbound maps URL, capped like
   * the Amap path — VIETMAP_API_BASE can point at an operator gateway, and an
   * unbounded answer used to be buffered whole before anyone looked at it.
   */
  private async call<T>(path: string, params: Record<string, string>, label: string): Promise<T> {
    const url = this.url(path, params);
    console.debug(`[Vietmap API] ${label} → ${path}`);

    const response = await safeFetchFollow(
      url,
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) },
      { bypassInternalIpAllowed: true },
    );

    if (!response.ok) {
      // Credential and quota failures must surface as such, not as empty
      // results: 401/403 → 403, 429 → 429, anything else is upstream trouble.
      const status = response.status === 401 || response.status === 403 ? 403
        : response.status === 429 ? 429
        : 502;
      discardBody(response);
      this.fail(label, status, `VIETMAP ${label} failed with HTTP ${response.status}`);
    }

    if (exceedsDeclaredLength(response, VIETMAP_MAX_RESPONSE_BYTES)) {
      discardBody(response);
      this.fail(label, 502, `VIETMAP ${label} answered with more than ${VIETMAP_MAX_RESPONSE_BYTES} bytes`);
    }
    return readCappedJson<T>(response, VIETMAP_MAX_RESPONSE_BYTES);
  }

  private fail(label: string, status: number, message: string): never {
    console.error(`[Maps] vietmap/${label} failed with ${status} userId=${this.credential.userId} keySource=${this.credential.source}`);
    const err = new Error(message) as Error & { status: number };
    err.status = status;
    throw err;
  }

  private toPlace(entry: VietmapEntry, detail?: VietmapPlaceDetail | null): ProviderPlace {
    return {
      vietmap_ref_id: vietmapText(entry.ref_id) ? `${VIETMAP_PLACE_ID_PREFIX}${vietmapText(entry.ref_id)}` : null,
      name: vietmapText(detail?.name) || vietmapText(entry.name),
      address: detail ? vietmapAddress(detail) : vietmapText(entry.address),
      lat: (detail ? vietmapNumber(detail.lat) : null) ?? vietmapNumber(entry.lat),
      lng: (detail ? vietmapNumber(detail.lng) : null) ?? vietmapNumber(entry.lng),
      rating: null,
      rating_count: null,
      website: null,
      phone: null,
      types: [],
      opening_hours: null,
      open_now: null,
      opening_periods: null,
      opening_special_days: null,
      summary: null,
      reviews: [],
      source: 'vietmap' as const,
    };
  }

  // ── PlacesProvider ─────────────────────────────────────────────────────────

  async searchText(query: string, _lang?: string, bias?: SearchBias): Promise<ProviderPlace[]> {
    const params: Record<string, string> = { text: query };
    if (bias) {
      params.focus = `${bias.lat},${bias.lng}`;
      if (bias.radius) {
        params.circle_center = params.focus;
        params.circle_radius = String(Math.round(bias.radius));
      }
    }
    const entries = await this.call<VietmapEntry[]>('/api/search/v3', params, 'search/v3');
    const list = (Array.isArray(entries) ? entries : []).filter(isVietmapEntry);

    // One place/v3 per row for coordinates — bounded to the first handful; a
    // row whose lookup fails still ships with its display fields and a null
    // coordinate rather than vanishing from the picker.
    const heads = list.slice(0, SEARCH_COORD_LOOKUPS);
    const details = await Promise.all(
      heads.map((e) =>
        vietmapText(e.ref_id)
          ? this.call<VietmapPlaceDetail>('/api/place/v3', { refid: vietmapText(e.ref_id) }, 'place/v3').catch(() => null)
          : Promise.resolve(null),
      ),
    );
    const places = heads.map((e, i) => this.toPlace(e, details[i] ?? null));
    for (const e of list.slice(SEARCH_COORD_LOOKUPS)) places.push(this.toPlace(e));
    return places;
  }

  // VIETMAP has no session concept and does not bill per keystroke, so the
  // Google path's session token has nothing to attach to here.
  async autocomplete(input: string, _lang?: string, bias?: ViewportBias): Promise<ProviderSuggestion[]> {
    const params: Record<string, string> = { text: input };
    // autocomplete biases around a point (focus), not a rectangle: the viewport
    // centre is the closest thing we can give it.
    if (bias) {
      // .toFixed(6): the midpoint of a float pair is often a repeating decimal.
      params.focus = `${((bias.low.lat + bias.high.lat) / 2).toFixed(6)},${((bias.low.lng + bias.high.lng) / 2).toFixed(6)}`;
    }
    const entries = await this.call<VietmapEntry[]>('/api/autocomplete/v3', params, 'autocomplete/v3');
    return (Array.isArray(entries) ? entries : [])
      .filter(isVietmapEntry)
      .filter((e) => vietmapText(e.ref_id))
      .slice(0, 5)
      .map((e) => ({
        placeId: `${VIETMAP_PLACE_ID_PREFIX}${vietmapText(e.ref_id)}`,
        mainText: vietmapText(e.name) || vietmapText(e.display),
        secondaryText: vietmapText(e.address),
      }));
  }

  async placeDetails(placeId: string, _lang?: string): Promise<ProviderPlace | null> {
    const refId = vietmapRefId(placeId);
    if (!refId) return null;
    const detail = await this.call<VietmapPlaceDetail>('/api/place/v3', { refid: refId }, `place/v3(${refId})`);
    if (!isVietmapEntry(detail) || Array.isArray(detail)) return null;
    return { ...this.toPlace({ ref_id: refId }, detail), cached_at: Date.now() };
  }

  /**
   * Reverse geocoding via `reverse/v3`, which returns coordinates and display
   * fields in one answer — no place/v3 hop needed. Worth having beyond
   * coverage: the OSM path funnels through the process-wide Nominatim throttle
   * (one request per 1.1 s), so an install on VIETMAP skips that queue.
   */
  async reverse(lat: number, lng: number, _lang?: string): Promise<{ name: string | null; address: string | null } | null> {
    const entries = await this.call<VietmapEntry[]>(
      '/api/reverse/v3',
      { lat: String(lat), lng: String(lng) },
      'reverse/v3',
    );
    const first = Array.isArray(entries) ? entries[0] : undefined;
    if (!first || !isVietmapEntry(first)) return null;
    return { name: vietmapText(first.name) || null, address: vietmapText(first.address) || vietmapText(first.display) || null };
  }
}
