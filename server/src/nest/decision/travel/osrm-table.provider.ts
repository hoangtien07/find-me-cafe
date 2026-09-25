import { Injectable } from '@nestjs/common';
import type { DecisionTravelMode } from '@trek/shared';
import type {
  TravelMatrixInput,
  TravelMatrixCell,
  TravelMatrixProvider,
  TravelMatrixResult,
} from './travel-matrix.provider';

/** Public demo server — a deployment should point OSRM_MATRIX_API_BASE at its own. */
const DEFAULT_BASE_URL = 'https://router.project-osrm.org';
const DEFAULT_TIMEOUT_MS = 10_000;
/** OSRM Table default cap is 10_000 cells; cap well below for urban groups. */
const MAX_ELEMENTS = 900;

/** OSRM profiles — no transit profile exists upstream. */
const PROFILE_MAP: Partial<Record<DecisionTravelMode, string>> = {
  driving: 'driving',
  cycling: 'cycling',
  walking: 'foot',
};

const asObject = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * Real matrix adapter — OSRM Table service (plan §10: the optional self-host /
 * low-cost path). `driving`, `cycling`, `foot` only: `transit` has no OSRM
 * profile, so a transit bucket fails the call rather than silently serving
 * car numbers.
 */
@Injectable()
export class OsrmTableMatrixProvider implements TravelMatrixProvider {
  readonly id = 'osrm';

  constructor(
    private readonly baseUrl: string = DEFAULT_BASE_URL,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async compute(input: TravelMatrixInput): Promise<TravelMatrixResult> {
    const elements = input.origins.length * input.destinations.length;
    if (elements === 0) return { cells: [], provider: this.id };
    if (elements > MAX_ELEMENTS) {
      throw new Error(`matrix ${input.origins.length}x${input.destinations.length} exceeds OSRM Table cap ${MAX_ELEMENTS}`);
    }
    const profile = PROFILE_MAP[input.mode];
    if (!profile) {
      throw new Error(`OSRM has no profile for mode '${input.mode}'`);
    }
    // Table takes one coordinate list + index lists for the two sides.
    const coords = [...input.origins, ...input.destinations]
      .map((c) => `${c.lng},${c.lat}`)
      .join(';');
    const sources = input.origins.map((_, i) => i).join(';');
    const destinations = input.destinations.map((_, i) => input.origins.length + i).join(';');
    const url =
      `${this.baseUrl}/table/v1/${profile}/${coords}` +
      `?sources=${sources}&destinations=${destinations}&annotations=duration,distance`;

    const res = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`OSRM Table ${res.status}: ${detail}`);
    }
    const body = asObject(await res.json());
    if (!body || body.code !== 'Ok' || !Array.isArray(body.durations)) {
      throw new Error(`OSRM Table unexpected response: ${JSON.stringify(body?.code ?? 'no body')}`);
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
          // OSRM uses null for unreachable cells.
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
