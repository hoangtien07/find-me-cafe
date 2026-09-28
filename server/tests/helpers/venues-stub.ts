import type { VenuesService } from '../../src/nest/venues/venues.service';

/**
 * A VenuesService that knows nothing: used where a test constructs MapsService
 * or DecisionService on a stubbed database that can't answer real venue SQL.
 * The venue seam degrades to "no local hits", which is exactly what these
 * tests exercise anyway.
 */
export function venuesStub(): VenuesService {
  return {
    search: () => [],
    findById: () => null,
    findForCandidate: () => null,
    enrichForCandidate: () => null,
    ingest: () => ({ venueId: -1, matched: 'new' }),
    count: () => 0,
  } as unknown as VenuesService;
}
