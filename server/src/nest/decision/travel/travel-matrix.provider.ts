import type { DecisionTravelMode } from '@trek/shared';

/** A coordinate the matrix works on — plain lat/lng, vendor-neutral. */
export interface TravelCoordinate {
  lat: number;
  lng: number;
}

/** One origins × destinations request, per spec §13. */
export interface TravelMatrixInput {
  origins: TravelCoordinate[];
  destinations: TravelCoordinate[];
  mode: DecisionTravelMode;
  departureAt?: string;
}

/** One cell of the matrix answer. `status` is explicit — never "absent means ok". */
export interface TravelMatrixCell {
  originIndex: number;
  destinationIndex: number;
  distanceMeters: number | null;
  durationSeconds: number | null;
  /** 'ok' | 'no_route' | 'error' — partial failures stay in the matrix. */
  status: string;
}

export interface TravelMatrixResult {
  cells: TravelMatrixCell[];
  /** The provider's own id — persisted on estimate rows for provenance. */
  provider: string;
}

/**
 * The vendor-neutral matrix the resolver depends on (spec §13): implementations
 * may be the deterministic mock or a real routing engine — the resolver never
 * knows which. Implementations must be async: a real provider performs IO.
 */
export interface TravelMatrixProvider {
  compute(input: TravelMatrixInput): Promise<TravelMatrixResult>;
}

/** DI token the resolver/matrix service consumes — the binding, not the class. */
export const TRAVEL_MATRIX_PROVIDER = 'TRAVEL_MATRIX_PROVIDER';
