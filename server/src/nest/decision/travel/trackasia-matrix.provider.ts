import { Injectable } from '@nestjs/common';
import type { DecisionTravelMode } from '@trek/shared';
import type {
  TravelMatrixInput,
  TravelMatrixCell,
  TravelMatrixProvider,
  TravelMatrixResult,
} from './travel-matrix.provider';

const DEFAULT_BASE_URL = 'https://maps.track-asia.com';
const DEFAULT_TIMEOUT_MS = 10_000;
/** Urban groups are small; keep one request well under the provider's point cap. */
const MAX_ELEMENTS = 900;

/**
 * TrackAsia Distance Matrix is OSRM-shaped (durations/distances matrices,
 * `code: 'Ok'`) but VN-profiled: `car|moto|truck|walk`. Buckets map onto the
 * VN-labelled chips — `cycling` is "Xe máy" → `moto`; `driving` is "Ô tô" →
 * `car`; `walking` is "Đi bộ" → `walk` (the only VN provider with an honest
 * pedestrian profile). `transit` still fails rather than faking numbers —
 * cells end up 'error', which the resolver reads as UNKNOWN≠PASS.
 */
const PROFILE_MAP: Partial<Record<DecisionTravelMode, string>> = {
  driving: 'car',
  cycling: 'moto',
  walking: 'walk',
};

const asObject = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * Real matrix adapter — TrackAsia Distance Matrix v1 (docs:
 * https://docs.track-asia.com/api-integration/distance-matrix/v1/). One GET:
 * `/distance-matrix/v1/{profile}/{lng,lat;...}?key=…&sources=&destinations=&annotations=`;
 * the response mirrors OSRM's shape including `null` for unreachable cells.
 * Billing is per request (not per cell) — cheap for group matrices.
 */
@Injectable()
export class TrackasiaMatrixProvider implements TravelMatrixProvider {
  readonly id = 'trackasia';

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async compute(input: TravelMatrixInput): Promise<TravelMatrixResult> {
    const elements = input.origins.length * input.destinations.length;
    if (elements === 0) return { cells: [], provider: this.id };
    if (elements > MAX_ELEMENTS) {
      throw new Error(`matrix ${input.origins.length}x${input.destinations.length} exceeds TrackAsia cap ${MAX_ELEMENTS}`);
    }
    const profile = PROFILE_MAP[input.mode];
    if (!profile) {
      throw new Error(`TrackAsia has no profile for mode '${input.mode}'`);
    }
    const coords = [...input.origins, ...input.destinations]
      .map((c) => `${c.lng},${c.lat}`)
      .join(';');
    const sources = input.origins.map((_, i) => i).join(';');
    const destinations = input.destinations.map((_, i) => input.origins.length + i).join(';');
    const url =
      `${this.baseUrl}/distance-matrix/v1/${profile}/${coords}` +
      `?key=${encodeURIComponent(this.apiKey)}&sources=${sources}&destinations=${destinations}&annotations=duration,distance`;

    const res = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`TrackAsia matrix ${res.status}: ${detail}`);
    }
    const body = asObject(await res.json());
    if (!body || body.code !== 'Ok' || !Array.isArray(body.durations)) {
      throw new Error(`TrackAsia matrix unexpected response: ${JSON.stringify(body?.code ?? 'no body')}`);
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
