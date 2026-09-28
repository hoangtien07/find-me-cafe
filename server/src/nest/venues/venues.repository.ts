import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type { ObservationInput, VenueFields, VenueRow } from './venues.types';

/**
 * SQL layer for the venue store. One class, all the statements; the service
 * above it owns matching policy and merge rules.
 */
@Injectable()
export class VenuesRepository {
  constructor(private readonly db: DatabaseService) {}

  /** Synchronous better-sqlite3 transaction passthrough. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(() => fn());
  }

  // ── observations ──────────────────────────────────────────────────────────

  insertObservation(obs: ObservationInput, venueId: number | null): number {
    const res = this.db.run(
      `INSERT INTO venue_observations (venue_id, source, external_id, external_refs_json, payload_json, license_tag, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      venueId,
      obs.source,
      obs.externalId,
      obs.externalRefs ? JSON.stringify(obs.externalRefs) : null,
      JSON.stringify(obs.payload),
      obs.licenseTag,
      obs.fetchedAt,
    );
    return Number(res.lastInsertRowid);
  }

  /** Newest fetched_at wins when the same source reports the same place twice. */
  findVenueByExternalId(source: string, externalId: string): number | null {
    const row = this.db.get<{ venue_id: number | null }>(
      `SELECT venue_id FROM venue_observations
        WHERE source = ? AND external_id = ? AND venue_id IS NOT NULL
        ORDER BY fetched_at DESC LIMIT 1`,
      source,
      externalId,
    );
    return row?.venue_id ?? null;
  }

  /** Any source's id for the venue — cross-provider joins ask this. */
  findVenueByAnyExternalId(externalId: string): number | null {
    const row = this.db.get<{ venue_id: number | null }>(
      `SELECT venue_id FROM venue_observations
        WHERE external_id = ? AND venue_id IS NOT NULL
        ORDER BY fetched_at DESC LIMIT 1`,
      externalId,
    );
    return row?.venue_id ?? null;
  }

  attachObservation(observationId: number, venueId: number): void {
    this.db.run('UPDATE venue_observations SET venue_id = ? WHERE id = ?', venueId, observationId);
  }

  // ── canonical rows ────────────────────────────────────────────────────────

  getVenue(id: number): VenueRow | null {
    return this.db.get<VenueRow>('SELECT * FROM venues WHERE id = ?', id) ?? null;
  }

  /** Candidate merge targets in the same or a neighbouring geohash6 cell. */
  findInCells(cells: string[]): VenueRow[] {
    if (cells.length === 0) return [];
    const marks = cells.map(() => '?').join(',');
    return this.db.all<VenueRow>(`SELECT * FROM venues WHERE geohash6 IN (${marks})`, ...cells);
  }

  insertVenue(fields: VenueFields & { name: string; name_normalized: string; lat: number; lng: number; geohash6: string; fetched_at: number; stale_at: number | null }): number {
    const res = this.db.run(
      `INSERT INTO venues (
         name, name_normalized, lat, lng, geohash6,
         address_freeform, address_ward, address_district, address_city, address_country,
         categories_json, category_primary, brand, confidence,
         phone, website, email, socials_json,
         rating, rating_count,
         price_raw, price_min_vnd, price_max_vnd, price_band,
         opening_hours_osm, open_24h, amenities_json,
         images_json, menu_images_json, thumbnail, streetview_thumb, popular_times_json,
         description, plus_code, last_review_at, top_reviews_json, fetched_at, stale_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      fields.name,
      fields.name_normalized,
      fields.lat,
      fields.lng,
      fields.geohash6,
      fields.address_freeform ?? null,
      fields.address_ward ?? null,
      fields.address_district ?? null,
      fields.address_city ?? null,
      fields.address_country ?? 'VN',
      fields.categories ? JSON.stringify(fields.categories) : null,
      fields.category_primary ?? null,
      fields.brand ?? null,
      fields.confidence ?? null,
      fields.phone ?? null,
      fields.website ?? null,
      fields.email ?? null,
      fields.socials ? JSON.stringify(fields.socials) : null,
      fields.rating ?? null,
      fields.rating_count ?? null,
      fields.price_raw ?? null,
      fields.price_min_vnd ?? null,
      fields.price_max_vnd ?? null,
      fields.price_band ?? null,
      fields.opening_hours_osm ?? null,
      fields.open_24h ? 1 : 0,
      fields.amenities ? JSON.stringify(fields.amenities) : null,
      fields.images ? JSON.stringify(fields.images) : null,
      fields.menu_images ? JSON.stringify(fields.menu_images) : null,
      fields.thumbnail ?? null,
      fields.streetview_thumb ?? null,
      fields.popular_times ? JSON.stringify(fields.popular_times) : null,
      fields.description ?? null,
      fields.plus_code ?? null,
      fields.last_review_at ?? null,
      fields.top_reviews ? JSON.stringify(fields.top_reviews) : null,
      fields.fetched_at,
      fields.stale_at,
    );
    const id = Number(res.lastInsertRowid);
    this.db.run(
      'INSERT INTO venues_fts (rowid, name_normalized, address_freeform, categories_json) VALUES (?, ?, ?, ?)',
      id,
      fields.name_normalized,
      fields.address_freeform ?? '',
      fields.categories ? JSON.stringify(fields.categories) : '',
    );
    return id;
  }

  /**
   * Merge newer fields into a canonical row. Existing values win on
   * non-null-by-both conflicts except freshness-gated ones the caller passes
   * explicitly — the merge policy lives in the service, this just writes the
   * resolved row.
   */
  updateVenue(
    id: number,
    fields: Partial<VenueFields> & { name_normalized?: string; fetched_at: number; stale_at: number | null },
  ): void {
    const sets: string[] = ['fetched_at = ?', 'stale_at = ?', 'updated_at = unixepoch()'];
    const vals: unknown[] = [fields.fetched_at, fields.stale_at];
    const col = (name: string, value: unknown): void => {
      sets.push(`${name} = ?`);
      vals.push(value);
    };
    if (fields.name !== undefined) col('name', fields.name);
    if (fields.name_normalized !== undefined) col('name_normalized', fields.name_normalized);
    if (fields.lat !== undefined) col('lat', fields.lat);
    if (fields.lng !== undefined) col('lng', fields.lng);
    if (fields.address_freeform !== undefined) col('address_freeform', fields.address_freeform);
    if (fields.address_ward !== undefined) col('address_ward', fields.address_ward);
    if (fields.address_district !== undefined) col('address_district', fields.address_district);
    if (fields.address_city !== undefined) col('address_city', fields.address_city);
    if (fields.categories !== undefined) col('categories_json', fields.categories ? JSON.stringify(fields.categories) : null);
    if (fields.category_primary !== undefined) col('category_primary', fields.category_primary);
    if (fields.brand !== undefined) col('brand', fields.brand);
    if (fields.confidence !== undefined) col('confidence', fields.confidence);
    if (fields.phone !== undefined) col('phone', fields.phone);
    if (fields.website !== undefined) col('website', fields.website);
    if (fields.email !== undefined) col('email', fields.email);
    if (fields.socials !== undefined) col('socials_json', fields.socials ? JSON.stringify(fields.socials) : null);
    if (fields.rating !== undefined) col('rating', fields.rating);
    if (fields.rating_count !== undefined) col('rating_count', fields.rating_count);
    if (fields.price_raw !== undefined) col('price_raw', fields.price_raw);
    if (fields.price_min_vnd !== undefined) col('price_min_vnd', fields.price_min_vnd);
    if (fields.price_max_vnd !== undefined) col('price_max_vnd', fields.price_max_vnd);
    if (fields.price_band !== undefined) col('price_band', fields.price_band);
    if (fields.opening_hours_osm !== undefined) col('opening_hours_osm', fields.opening_hours_osm);
    if (fields.open_24h !== undefined) col('open_24h', fields.open_24h ? 1 : 0);
    if (fields.amenities !== undefined) col('amenities_json', fields.amenities ? JSON.stringify(fields.amenities) : null);
    if (fields.images !== undefined) col('images_json', fields.images ? JSON.stringify(fields.images) : null);
    if (fields.menu_images !== undefined) col('menu_images_json', fields.menu_images ? JSON.stringify(fields.menu_images) : null);
    if (fields.thumbnail !== undefined) col('thumbnail', fields.thumbnail);
    if (fields.streetview_thumb !== undefined) col('streetview_thumb', fields.streetview_thumb);
    if (fields.popular_times !== undefined) col('popular_times_json', fields.popular_times ? JSON.stringify(fields.popular_times) : null);
    if (fields.description !== undefined) col('description', fields.description);
    if (fields.plus_code !== undefined) col('plus_code', fields.plus_code);
    if (fields.last_review_at !== undefined) col('last_review_at', fields.last_review_at);
    if (fields.top_reviews !== undefined) col('top_reviews_json', fields.top_reviews ? JSON.stringify(fields.top_reviews) : null);
    vals.push(id);
    this.db.run(`UPDATE venues SET ${sets.join(', ')} WHERE id = ?`, ...vals);
    // Keep the FTS row in step when searchable text changed.
    if (fields.name !== undefined || fields.address_freeform !== undefined || fields.categories !== undefined) {
      const row = this.getVenue(id);
      if (row) {
        this.db.run('DELETE FROM venues_fts WHERE rowid = ?', id);
        this.db.run(
          'INSERT INTO venues_fts (rowid, name_normalized, address_freeform, categories_json) VALUES (?, ?, ?, ?)',
          id,
          row.name_normalized,
          row.address_freeform ?? '',
          row.categories_json ?? '',
        );
      }
    }
  }

  // ── search ────────────────────────────────────────────────────────────────

  /**
   * FTS5 match on the folded-name columns plus a geo-distance order when a
   * bias is given. Query tokens are already normalized by the caller.
   */
  search(ftsQuery: string, limit: number): VenueRow[] {
    return this.db.all<VenueRow>(
      `SELECT v.* FROM venues v
        JOIN venues_fts f ON f.rowid = v.id
        WHERE venues_fts MATCH ?
        LIMIT ?`,
      ftsQuery,
      limit,
    );
  }

  /** Geo-only listing for the bias path when the FTS query is empty. */
  searchNear(lat: number, lng: number, cells: string[], limit: number): VenueRow[] {
    if (cells.length === 0) return [];
    const marks = cells.map(() => '?').join(',');
    return this.db.all<VenueRow>(
      `SELECT * FROM venues WHERE geohash6 IN (${marks}) LIMIT ?`,
      ...cells,
      limit,
    );
  }

  countVenues(): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) n FROM venues')!.n;
  }
}
