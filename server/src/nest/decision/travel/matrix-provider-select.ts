import type { TravelMatrixProvider } from './travel-matrix.provider';
import { MockTravelMatrixProvider } from './mock-travel-matrix.provider';
import { GoogleRoutesMatrixProvider } from './google-routes.provider';
import { OsrmTableMatrixProvider } from './osrm-table.provider';

const DEFAULT_MATRIX_TIMEOUT_MS = 10_000;

function parseTimeoutMs(v: string | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1000 && n <= 60_000 ? n : DEFAULT_MATRIX_TIMEOUT_MS;
}

/**
 * Picks the TravelMatrixProvider for this deployment from
 * `DECISION_MATRIX_PROVIDER` ('mock' | 'google' | 'osrm', default 'mock').
 *
 * Fail closed: selecting a real provider without its configuration throws at
 * boot — never a silent fall back to fixture data while pretending the matrix
 * is real.
 */
export function selectMatrixProvider(env: NodeJS.ProcessEnv): TravelMatrixProvider {
  const name = (env.DECISION_MATRIX_PROVIDER ?? 'mock').trim().toLowerCase();
  const timeoutMs = parseTimeoutMs(env.DECISION_MATRIX_TIMEOUT_MS);
  switch (name) {
    case 'mock':
      return new MockTravelMatrixProvider();
    case 'google': {
      const key = env.GOOGLE_ROUTES_API_KEY?.trim();
      if (!key) {
        throw new Error('DECISION_MATRIX_PROVIDER=google requires GOOGLE_ROUTES_API_KEY');
      }
      return new GoogleRoutesMatrixProvider(key, env.GOOGLE_ROUTES_API_BASE?.trim() || undefined, timeoutMs);
    }
    case 'osrm':
      return new OsrmTableMatrixProvider(env.OSRM_MATRIX_API_BASE?.trim() || undefined, timeoutMs);
    default:
      throw new Error(`unknown DECISION_MATRIX_PROVIDER '${name}' (mock|google|osrm)`);
  }
}
