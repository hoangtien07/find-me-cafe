import { Injectable } from '@nestjs/common';
import { haversineMetres } from '../../common/geo';
import type {
  TravelMatrixInput,
  TravelMatrixProvider,
  TravelMatrixResult,
} from './travel-matrix.provider';

/**
 * Deterministic fixture provider for VS-07 (spec §13: prove the domain
 * pipeline before choosing a real routing vendor).
 *
 * Distance is the great-circle (haversine) distance inflated by a fixed
 * detour factor; duration is distance over a per-mode city speed. Same input
 * in, same numbers out — resolver tests can assert on them exactly.
 *
 * Fixture escape hatch (documented so tests can trigger it deliberately):
 * a coordinate at exactly (0, 0) or a non-finite coordinate → 'no_route'.
 */
@Injectable()
export class MockTravelMatrixProvider implements TravelMatrixProvider {
  readonly id = 'mock';

  /** Urban speeds in metres/second, per mode — deterministic fixtures. */
  private static SPEED_MPS: Record<string, number> = {
    walking: 1.4,
    cycling: 4.2,
    transit: 5.6,
    driving: 7.0,
  };

  /** Road networks are not straight lines; 1.3 detour factor is the fixture. */
  private static DETOUR_FACTOR = 1.3;

  async compute(input: TravelMatrixInput): Promise<TravelMatrixResult> {
    const cells = [];
    for (let oi = 0; oi < input.origins.length; oi++) {
      const origin = input.origins[oi]!;
      for (let di = 0; di < input.destinations.length; di++) {
        const dest = input.destinations[di]!;
        const direct = haversineMetres(origin.lat, origin.lng, dest.lat, dest.lng);
        const unroutable =
          !Number.isFinite(direct) ||
          (origin.lat === 0 && origin.lng === 0) ||
          (dest.lat === 0 && dest.lng === 0);
        if (unroutable) {
          cells.push({
            originIndex: oi,
            destinationIndex: di,
            distanceMeters: null,
            durationSeconds: null,
            status: 'no_route',
          });
          continue;
        }
        const distanceMeters = Math.round(direct * MockTravelMatrixProvider.DETOUR_FACTOR);
        const speed =
          MockTravelMatrixProvider.SPEED_MPS[input.mode] ?? MockTravelMatrixProvider.SPEED_MPS['driving']!;
        cells.push({
          originIndex: oi,
          destinationIndex: di,
          distanceMeters,
          durationSeconds: Math.round(distanceMeters / speed),
          status: 'ok',
        });
      }
    }
    return { cells, provider: this.id };
  }
}
