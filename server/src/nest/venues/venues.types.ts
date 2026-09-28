/**
 * The proprietary venue database — types.
 *
 * Two tiers back each other (see the migration): `venue_observations` keeps
 * every third-party pull raw with provenance and a license tag, `venues`
 * holds one canonical merged row per real-world place. Search and the
 * decision snapshot read the canonical tier; nothing else writes it except
 * the merge path in VenuesService.
 *
 * Canonical fields deliberately mirror the TREK index's `TrekPlace` (Overture
 * shape) plus the enrichment fields the resolver needs — rating, opening
 * hours, price band — that open indexes do not carry.
 */

/** A canonical `venues` row, as persisted. */
export interface VenueRow {
  id: number;
  name: string;
  name_normalized: string;
  lat: number;
  lng: number;
  geohash6: string;
  address_freeform: string | null;
  address_ward: string | null;
  address_district: string | null;
  address_city: string | null;
  address_country: string | null;
  categories_json: string | null;
  category_primary: string | null;
  brand: string | null;
  confidence: number | null;
  phone: string | null;
  website: string | null;
  email: string | null;
  socials_json: string | null;
  rating: number | null;
  rating_count: number | null;
  price_raw: string | null;
  price_min_vnd: number | null;
  price_max_vnd: number | null;
  price_band: string | null;
  opening_hours_osm: string | null;
  open_24h: number;
  amenities_json: string | null;
  images_json: string | null;
  menu_images_json: string | null;
  thumbnail: string | null;
  streetview_thumb: string | null;
  popular_times_json: string | null;
  description: string | null;
  plus_code: string | null;
  fetched_at: number;
  stale_at: number | null;
  created_at: number;
  updated_at: number;
}

/** Fields a payload contributes when merged into a canonical row. All
 * optional: a source answers what it knows, the merge keeps the rest. */
export interface VenueFields {
  name?: string | null;
  lat?: number | null;
  lng?: number | null;
  address_freeform?: string | null;
  address_ward?: string | null;
  address_district?: string | null;
  address_city?: string | null;
  address_country?: string | null;
  categories?: string[] | null;
  category_primary?: string | null;
  brand?: string | null;
  confidence?: number | null;
  phone?: string | null;
  website?: string | null;
  email?: string | null;
  socials?: string[] | null;
  rating?: number | null;
  rating_count?: number | null;
  price_raw?: string | null;
  price_min_vnd?: number | null;
  price_max_vnd?: number | null;
  price_band?: string | null;
  opening_hours_osm?: string | null;
  open_24h?: boolean | null;
  amenities?: Record<string, boolean> | null;
  images?: string[] | null;
  menu_images?: string[] | null;
  thumbnail?: string | null;
  streetview_thumb?: string | null;
  popular_times?: Record<string, unknown> | null;
  description?: string | null;
  plus_code?: string | null;
}

/** One observed record, pre-persistence. */
export interface ObservationInput {
  source: string;
  externalId: string;
  externalRefs?: Record<string, unknown> | null;
  payload: Record<string, unknown>;
  licenseTag: string;
  fetchedAt: number;
}

/** Outcome of ingest: which canonical row the observation landed on. */
export interface IngestResult {
  venueId: number;
  matched: 'external_id' | 'phone' | 'geo_name' | 'new';
}
