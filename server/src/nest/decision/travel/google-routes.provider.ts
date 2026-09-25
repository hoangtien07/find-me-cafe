import { Injectable } from '@nestjs/common';
import type { DecisionTravelMode } from '@trek/shared';
import type {
  TravelMatrixInput,
  TravelMatrixCell,
  TravelMatrixProvider,
  TravelMatrixResult,
} from './travel-matrix.provider';

/** Routes API v2 computeRouteMatrix endpoint (overridable for gateways/tests). */
const DEFAULT_BASE_URL = 'https://routes.googleapis.com';
const COMPUTE_MATRIX_PATH = '/distanceMatrix/v2:computeRouteMatrix';
const DEFAULT_TIMEOUT_MS = 10_000;
/** Non-PRO Routes API matrix cap: 25 origins × 25 destinations. */
const MAX_ELEMENTS = 625;

/** Decision modes → Routes API travelMode. cycling is the VN two-wheeler. */
const MODE_MAP: Record<DecisionTravelMode, string> = {
  walking: 'WALK',
  driving: 'DRIVE',
  cycling: 'TWO_WHEELER',
  transit: 'TRANSIT',
};

interface RoutesMatrixElement {
  originIndex?: number;
  destinationIndex?: number;
  /** 'ROUTE_EXISTS' | 'ROUTE_NOT_FOUND' | 'NO_ROUTE_FOUND' | 'ROUTE_EXISTS_DURATION_ONLY' */
  condition?: string;
  distanceMeters?: number;
  /** Proto Duration JSON — a seconds string like "900s". */
  duration?: string;
  /** Present on per-element errors (e.g. bad waypoint). */
  status?: { code?: number; message?: string };
}

const asObject = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const asElement = (v: unknown): RoutesMatrixElement | null => (asObject(v) as RoutesMatrixElement | null);

/** Proto Duration "900s" → 900. Anything else is a boundary failure → null. */
function parseProtoDuration(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string') {
    const m = /^(-?\d+(?:\.\d+)?)s$/.exec(v.trim());
    if (m) return Math.round(Number(m[1]));
  }
  return null;
}

/**
 * Real matrix adapter — Google Routes `computeRouteMatrix` (plan §10).
 * One call per (mode, session) bucket from TravelMatrixService. Every
 * untrusted bit is validated at the boundary; a malformed element becomes an
 * explicit 'error' cell, never a silently-fake number.
 */
@Injectable()
export class GoogleRoutesMatrixProvider implements TravelMatrixProvider {
  readonly id = 'google';

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async compute(input: TravelMatrixInput): Promise<TravelMatrixResult> {
    const elements = input.origins.length * input.destinations.length;
    if (elements === 0) return { cells: [], provider: this.id };
    if (elements > MAX_ELEMENTS) {
      throw new Error(`matrix ${input.origins.length}x${input.destinations.length} exceeds Routes API limit ${MAX_ELEMENTS}`);
    }
    const waypoint = (c: { lat: number; lng: number }) => ({
      waypoint: { location: { latLng: { latitude: c.lat, longitude: c.lng } } },
    });
    const body: Record<string, unknown> = {
      origins: input.origins.map(waypoint),
      destinations: input.destinations.map(waypoint),
      travelMode: MODE_MAP[input.mode] ?? 'DRIVE',
    };
    if (input.departureAt) body.departureTime = input.departureAt;

    const res = await fetch(`${this.baseUrl}${COMPUTE_MATRIX_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.apiKey,
        // Field mask = minimal response: only what a cell needs (plan §27 M2-05).
        'X-Goog-FieldMask': 'originIndex,destinationIndex,condition,status,distanceMeters,duration',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`Routes API ${res.status}: ${detail}`);
    }

    const raw: unknown = await res.json();
    const list = Array.isArray(raw) ? raw : [];
    const byIndex = new Map<string, RoutesMatrixElement>();
    for (const item of list) {
      const el = asElement(item);
      if (!el) continue;
      if (typeof el.originIndex !== 'number' || typeof el.destinationIndex !== 'number') continue;
      byIndex.set(`${el.originIndex}:${el.destinationIndex}`, el);
    }

    const cells: TravelMatrixCell[] = [];
    for (let oi = 0; oi < input.origins.length; oi++) {
      for (let di = 0; di < input.destinations.length; di++) {
        cells.push(this.toCell(oi, di, byIndex.get(`${oi}:${di}`)));
      }
    }
    return { cells, provider: this.id };
  }

  private toCell(oi: number, di: number, el: RoutesMatrixElement | undefined): TravelMatrixCell {
    if (!el) return { originIndex: oi, destinationIndex: di, distanceMeters: null, durationSeconds: null, status: 'error' };
    if (el.status && Object.keys(el.status).length > 0) {
      return { originIndex: oi, destinationIndex: di, distanceMeters: null, durationSeconds: null, status: 'error' };
    }
    if (el.condition !== 'ROUTE_EXISTS' && el.condition !== 'ROUTE_EXISTS_DURATION_ONLY') {
      return { originIndex: oi, destinationIndex: di, distanceMeters: null, durationSeconds: null, status: 'no_route' };
    }
    const durationSeconds = parseProtoDuration(el.duration);
    return {
      originIndex: oi,
      destinationIndex: di,
      distanceMeters: typeof el.distanceMeters === 'number' && Number.isFinite(el.distanceMeters) ? Math.round(el.distanceMeters) : null,
      durationSeconds,
      status: 'ok',
    };
  }
}
