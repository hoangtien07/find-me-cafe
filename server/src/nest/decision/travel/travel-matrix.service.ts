import { Inject, Injectable } from '@nestjs/common';
import type { DecisionTravelEstimate, DecisionTravelMode } from '@trek/shared';
import { DatabaseService } from '../../database/database.service';
import { TRAVEL_MATRIX_PROVIDER } from './travel-matrix.provider';
import type { TravelMatrixProvider, TravelCoordinate } from './travel-matrix.provider';

/** How long a computed cell is trusted before recomputation (24h). */
const ESTIMATE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Builds the participants × candidates travel matrix for a session and
 * persists it as `decision_travel_estimates` rows — one per
 * (session, participant, candidate, mode) cell, keyed UNIQUE so repeat runs
 * are cache hits, not dupes.
 *
 * Cells that cannot be computed are still persisted with an explicit status —
 * 'missing_origin' (participant never submitted one), 'missing_destination'
 * (candidate snapshot has no coordinates), 'no_route'/'error' from the
 * provider — because the resolver treats a silent hole as UNKNOWN≠PASS, and a
 * real cell row is how a hole stays visible.
 */
@Injectable()
export class TravelMatrixService {
  constructor(
    private readonly db: DatabaseService,
    @Inject(TRAVEL_MATRIX_PROVIDER) private readonly provider: TravelMatrixProvider,
  ) {}

  /** Load the persisted matrix cells for a session. */
  listEstimates(sessionId: number): DecisionTravelEstimate[] {
    return this.db.all<DecisionTravelEstimate>(
      'SELECT * FROM decision_travel_estimates WHERE decision_session_id = ? ORDER BY participant_id, candidate_id',
      sessionId,
    );
  }

  /**
   * Compute (or reuse fresh cache rows for) the full session matrix. Returns
   * the persisted cells. `force` recomputes everything — used by resolve.
   */
  async computeSessionMatrix(sessionId: number, travelMode: DecisionTravelMode, force = false): Promise<DecisionTravelEstimate[]> {
    const participants = this.db.all<{ id: number; origin_lat: number | null; origin_lng: number | null }>(
      'SELECT id, origin_lat, origin_lng FROM decision_participants WHERE decision_session_id = ?',
      sessionId,
    );
    const candidates = this.db.all<{ id: number; lat: number | null; lng: number | null }>(
      `SELECT dc.id,
              CAST(json_extract(dc.snapshot_json, '$.lat') AS REAL) AS lat,
              CAST(json_extract(dc.snapshot_json, '$.lng') AS REAL) AS lng
         FROM decision_candidates dc WHERE dc.decision_session_id = ?`,
      sessionId,
    );

    const origins: TravelCoordinate[] = [];
    const originIndex: (number | null)[] = []; // participant index -> origin index or null
    for (const p of participants) {
      if (p.origin_lat === null || p.origin_lng === null) {
        originIndex.push(null);
      } else {
        originIndex.push(origins.length);
        origins.push({ lat: p.origin_lat, lng: p.origin_lng });
      }
    }
    const destinations: TravelCoordinate[] = [];
    const destinationIndex: (number | null)[] = [];
    for (const c of candidates) {
      if (c.lat === null || c.lng === null || !Number.isFinite(c.lat) || !Number.isFinite(c.lng)) {
        destinationIndex.push(null);
      } else {
        destinationIndex.push(destinations.length);
        destinations.push({ lat: c.lat, lng: c.lng });
      }
    }

    // Cells that already exist and are still fresh stay as-is (cache).
    const freshCutoff = new Date(Date.now() - ESTIMATE_TTL_MS).toISOString();
    const fresh = new Set<string>();
    if (!force) {
      for (const row of this.db.all<{ participant_id: number; candidate_id: number }>(
        `SELECT participant_id, candidate_id FROM decision_travel_estimates
          WHERE decision_session_id = ? AND travel_mode = ? AND computed_at > ?`,
        sessionId,
        travelMode,
        freshCutoff,
      )) {
        fresh.add(`${row.participant_id}:${row.candidate_id}`);
      }
    }

    const result =
      origins.length > 0 && destinations.length > 0
        ? await this.provider.compute({ origins, destinations, mode: travelMode }).catch(() => null)
        : null;
    const providerName = result?.provider ?? 'unknown';
    const cellByIdx = new Map<string, { distanceMeters: number | null; durationSeconds: number | null; status: string }>();
    for (const cell of result?.cells ?? []) {
      cellByIdx.set(`${cell.originIndex}:${cell.destinationIndex}`, cell);
    }

    const insert = this.db.prepare(
      `INSERT INTO decision_travel_estimates
         (decision_session_id, participant_id, candidate_id, travel_mode, distance_meters, duration_seconds, status, provider, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (decision_session_id, participant_id, candidate_id, travel_mode)
       DO UPDATE SET distance_meters = excluded.distance_meters,
                     duration_seconds = excluded.duration_seconds,
                     status = excluded.status,
                     provider = excluded.provider,
                     computed_at = excluded.computed_at`,
    );

    this.db.transaction(() => {
      for (let pi = 0; pi < participants.length; pi++) {
        const p = participants[pi]!;
        for (let ci = 0; ci < candidates.length; ci++) {
          const c = candidates[ci]!;
          if (fresh.has(`${p.id}:${c.id}`)) continue;
          const oi = originIndex[pi];
          const di = destinationIndex[ci];
          let status: string;
          let distance: number | null = null;
          let duration: number | null = null;
          if (oi === null) {
            status = 'missing_origin';
          } else if (di === null) {
            status = 'missing_destination';
          } else if (result === null) {
            status = 'error';
          } else {
            const cell = cellByIdx.get(`${oi}:${di}`);
            status = cell?.status ?? 'error';
            distance = cell?.distanceMeters ?? null;
            duration = cell?.durationSeconds ?? null;
          }
          insert.run(sessionId, p.id, c.id, travelMode, distance, duration, status, providerName);
        }
      }
    });

    return this.listEstimates(sessionId);
  }
}
