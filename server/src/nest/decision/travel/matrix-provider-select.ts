import { deriveDecision } from '../../../app-config/derive';
import type { TravelMatrixProvider } from './travel-matrix.provider';
import { MockTravelMatrixProvider } from './mock-travel-matrix.provider';
import { GoogleRoutesMatrixProvider } from './google-routes.provider';
import { OsrmTableMatrixProvider } from './osrm-table.provider';
import { VietmapMatrixProvider } from './vietmap-matrix.provider';
import { TrackasiaMatrixProvider } from './trackasia-matrix.provider';

const DEFAULT_MATRIX_TIMEOUT_MS = 10_000;

function parseTimeoutMs(v: string | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1000 && n <= 60_000 ? n : DEFAULT_MATRIX_TIMEOUT_MS;
}

/**
 * Picks the TravelMatrixProvider for this deployment from
 * `DECISION_MATRIX_PROVIDER` ('mock' | 'google' | 'osrm' | 'vietmap' | 'trackasia', default 'mock').
 *
 * Fail closed: selecting a real provider without its configuration throws at
 * boot — never a silent fall back to fixture data while pretending the matrix
 * is real.
 */
export function selectMatrixProvider(env: ReturnType<typeof deriveDecision>): TravelMatrixProvider {
  const name = (env.matrixProvider ?? 'mock').trim().toLowerCase();
  const timeoutMs = parseTimeoutMs(env.matrixTimeoutMs);
  switch (name) {
    case 'mock':
      return new MockTravelMatrixProvider();
    case 'google': {
      const key = env.googleRoutesApiKey?.trim();
      if (!key) {
        throw new Error('DECISION_MATRIX_PROVIDER=google requires GOOGLE_ROUTES_API_KEY');
      }
      return new GoogleRoutesMatrixProvider(key, env.googleRoutesApiBase?.trim() || undefined, timeoutMs);
    }
    case 'osrm':
      return new OsrmTableMatrixProvider(env.osrmMatrixApiBase?.trim() || undefined, timeoutMs);
    case 'vietmap': {
      const key = env.vietmapApiKey?.trim();
      if (!key) {
        throw new Error('DECISION_MATRIX_PROVIDER=vietmap requires VIETMAP_API_KEY');
      }
      return new VietmapMatrixProvider(key, env.vietmapApiBase?.trim() || undefined, timeoutMs);
    }
    case 'trackasia': {
      const key = env.trackasiaApiKey?.trim();
      if (!key) {
        throw new Error('DECISION_MATRIX_PROVIDER=trackasia requires TRACKASIA_API_KEY');
      }
      return new TrackasiaMatrixProvider(key, env.trackasiaApiBase?.trim() || undefined, timeoutMs);
    }
    default:
      throw new Error(`unknown DECISION_MATRIX_PROVIDER '${name}' (mock|google|osrm|vietmap|trackasia)`);
  }
}
