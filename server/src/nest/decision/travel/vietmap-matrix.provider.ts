import { Injectable } from '@nestjs/common';
import type { DecisionTravelMode } from '@trek/shared';
import type {
  TravelMatrixInput,
  TravelMatrixCell,
  TravelMatrixProvider,
  TravelMatrixResult,
} from './travel-matrix.provider';

const DEFAULT_BASE_URL = 'https://maps.vietmap.vn';
const DEFAULT_TIMEOUT_MS = 10_000;
/** Keep one request well under the per-plan point cap — urban groups are small. */
const MAX_ELEMENTS = 900;

/**
 * VIETMAP vehicle profiles are `car|motorcycle|truck|container` only. The
 * product's `driving` bucket is motorbike travel for the VN market (same
 * convention as the Google adapter's TWO_WHEELER); the remaining modes have
 * no honest profile, so they fail the call instead of serving motorcycle
 * numbers for a walker — cells end up 'error', which the resolver reads as
 * UNKNOWN≠PASS rather than a pass.
 */
const PROFILE_MAP: Partial<Record<DecisionTravelMode, string>> = {
  driving: 'motorcycle',
};

const asObject = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * Real matrix adapter — VIETMAP Matrix v4 (docs:
 * https://maps.vietmap.vn/docs/map-api/matrix-version/matrix-v4/). One GET
 * with all points (`point=lat,lng` — latitude first), index lists for
 * sources/destinations, `vehicle=motorcycle`, `annotation=duration,distance`;
 * the response mirrors OSRM's shape (`durations`/`distances` matrices plus a
 * `code` status — 'OK' on success, INVALID_REQUEST / OVER_DAILY_LIMIT /
 * MAX_POINTS_EXCEED / ERROR_UNKNOWN otherwise).
 */
@Injectable()
export class VietmapMatrixProvider implements TravelMatrixProvider {
  readonly id = 'vietmap';

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async compute(input: TravelMatrixInput): Promise<TravelMatrixResult> {
    const elements = input.origins.length * input.destinations.length;
    if (elements === 0) return { cells: [], provider: this.id };
    if (elements > MAX_ELEMENTS) {
      throw new Error(`matrix ${input.origins.length}x${input.destinations.length} exceeds VIETMAP cap ${MAX_ELEMENTS}`);
    }
    const vehicle = PROFILE_MAP[input.mode];
    if (!vehicle) {
      throw new Error(`VIETMAP has no profile for mode '${input.mode}'`);
    }
    const params = new URLSearchParams();
    params.set('apikey', this.apiKey);
    for (const c of [...input.origins, ...input.destinations]) {
      params.append('point', `${c.lat},${c.lng}`);
    }
    params.set('vehicle', vehicle);
    params.set('sources', input.origins.map((_, i) => i).join(';'));
    params.set('destinations', input.destinations.map((_, i) => input.origins.length + i).join(';'));
    params.set('annotation', 'duration,distance');
    const url = `${this.baseUrl}/api/matrix/v4?${params.toString()}`;

    const res = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`VIETMAP Matrix ${res.status}: ${detail}`);
    }
    const body = asObject(await res.json());
    if (!body || body.code !== 'OK' || !Array.isArray(body.durations)) {
      throw new Error(`VIETMAP Matrix unexpected response: ${JSON.stringify(body?.code ?? 'no body')}`);
    }
    const durations = body.durations as unknown[];
    const distances = Array.isArray(body.distances) ? (body.distances as unknown[]) : [];

    const cells: TravelMatrixCell[] = [];
    for (let oi = 0; oi < input.origins.length; oi++) {
      const durRow = Array.isArray(durations[oi]) ? (durations[oi] as unknown[]) : [];
      const distRow = Array.isArray(distances[oi]) ? (distances[oi] as unknown[]) : [];
      for (let di = 0; di < input.destinations.length; di++) {
        const duration = durRow[di];
        const distance = distRow[di];
        if (typeof duration !== 'number' || !Number.isFinite(duration)) {
          cells.push({ originIndex: oi, destinationIndex: di, distanceMeters: null, durationSeconds: null, status: 'no_route' });
          continue;
        }
        cells.push({
          originIndex: oi,
          destinationIndex: di,
          distanceMeters: typeof distance === 'number' && Number.isFinite(distance) ? Math.round(distance) : null,
          durationSeconds: Math.round(duration),
          status: 'ok',
        });
      }
    }
    return { cells, provider: this.id };
  }
}
