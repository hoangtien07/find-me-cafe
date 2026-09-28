import { Injectable } from '@nestjs/common';
import { VenuesRepository } from './venues.repository';
import {
  aboutToAmenities,
  geohash6,
  geohashNeighbours,
  haversineMetres,
  nameSimilarity,
  normalizePhone,
  normalizeVnCategory,
  normalizeVnName,
  parseVnOpenHours,
  parseVnPriceRange,
} from './venue-normalize';
import type { IngestResult, ObservationInput, VenueFields, VenueRow } from './venues.types';

/**
 * The venue store's brain: ingest policy (raw observation in, canonical row
 * merged), entity matching across sources that share no id namespace, and the
 * read faces the rest of the app uses — search results and snapshot fills.
 *
 * Staleness: hours and price decay (90 days) — a stale value still displays
 * but the resolver treats it as UNKNOWN once stale_at passes, so scraped
 * evidence ages out honestly instead of silently lying.
 */

const STALE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Geo+name merge thresholds. Under ~50 m and a strong token overlap is the
 *  same shop; below 0.6 similarity the pair is left alone. */
const MATCH_RADIUS_M = 50;
const NAME_SIM_STRONG = 0.8;
const NAME_SIM_WITH_CATEGORY = 0.6;

@Injectable()
export class VenuesService {
  constructor(private readonly repo: VenuesRepository) {}

  /**
   * Persist one third-party record. The raw payload lands in
   * venue_observations first (append-only, license-tagged), then the
   * extracted fields merge into a canonical venue row — existing or new.
   */
  ingest(obs: ObservationInput, fields: VenueFields): IngestResult {
    const hasIdentity =
      typeof fields.name === 'string' && fields.name.length > 0 &&
      typeof fields.lat === 'number' && Number.isFinite(fields.lat) &&
      typeof fields.lng === 'number' && Number.isFinite(fields.lng);

    return this.repo.transaction(() => {
      const match = hasIdentity ? this.match(fields, obs.externalId) : { venueId: null, via: 'new' as const };
      const obsId = this.repo.insertObservation(obs, match.venueId);

      if (match.venueId !== null) {
        this.repo.updateVenue(match.venueId, this.mergeFields(match.venueId, fields, obs.fetchedAt));
        return { venueId: match.venueId, matched: match.via };
      }
      if (!hasIdentity) return { venueId: -1, matched: 'new' }; // observation kept, no venue

      const venueId = this.repo.insertVenue({
        name: fields.name!,
        name_normalized: normalizeVnName(fields.name!),
        lat: fields.lat!,
        lng: fields.lng!,
        geohash6: geohash6(fields.lat!, fields.lng!),
        ...fields,
        fetched_at: obs.fetchedAt,
        stale_at: this.staleAt(obs.fetchedAt, fields),
      });
      this.repo.attachObservation(obsId, venueId);
      return { venueId, matched: 'new' };
    });
  }

  /**
   * Entity resolution. Same real place arrives under unrelated ids
   * (`place_id` vs `trackasia:` vs `gers:`), so the join is:
   * external id → phone → same geo cell + name similarity.
   */
  private match(fields: VenueFields, externalId: string): { venueId: number | null; via: IngestResult['matched'] } {
    const byId = this.repo.findVenueByAnyExternalId(externalId);
    if (byId !== null) return { venueId: byId, via: 'external_id' };

    const phone = normalizePhone(fields.phone);
    if (phone) {
      for (const v of this.candidatesNear(fields.lat!, fields.lng!)) {
        if (v.phone && normalizePhone(v.phone) === phone) {
          return { venueId: v.id, via: 'phone' };
        }
      }
    }

    const norm = normalizeVnName(fields.name!);
    for (const v of this.candidatesNear(fields.lat!, fields.lng!)) {
      if (haversineMetres(v.lat, v.lng, fields.lat!, fields.lng!) > MATCH_RADIUS_M) continue;
      const sim = nameSimilarity(norm, v.name_normalized);
      if (sim >= NAME_SIM_STRONG) return { venueId: v.id, via: 'geo_name' };
      if (sim >= NAME_SIM_WITH_CATEGORY && fields.category_primary && v.category_primary === fields.category_primary) {
        return { venueId: v.id, via: 'geo_name' };
      }
    }
    return { venueId: null, via: 'new' };
  }

  private candidatesNear(lat: number, lng: number): VenueRow[] {
    const cell = geohash6(lat, lng);
    return this.repo.findInCells([cell, ...geohashNeighbours(cell)]);
  }

  /** Null-fill merge: a source contributes what it knows; it never blanks a
   *  value another source already recorded. fetched_at/stale_at always move. */
  private mergeFields(
    venueId: number,
    fields: VenueFields,
    fetchedAt: number,
  ): Partial<VenueFields> & { name_normalized?: string; fetched_at: number; stale_at: number | null } {
    const row = this.repo.getVenue(venueId);
    if (!row) return { fetched_at: fetchedAt, stale_at: null };
    const out: Partial<VenueFields> & { name_normalized?: string; fetched_at: number; stale_at: number | null } = {
      fetched_at: Math.max(row.fetched_at, fetchedAt),
      stale_at: this.staleAt(fetchedAt, fields) ?? row.stale_at,
    };
    const fill = <K extends keyof VenueFields>(key: K, current: unknown): void => {
      const value = fields[key];
      if (value !== undefined && value !== null && (current === null || current === undefined || current === '')) {
        (out as Record<string, unknown>)[key] = value;
      }
    };
    fill('address_freeform', row.address_freeform);
    fill('address_ward', row.address_ward);
    fill('address_district', row.address_district);
    fill('address_city', row.address_city);
    fill('categories', row.categories_json);
    fill('category_primary', row.category_primary);
    fill('brand', row.brand);
    fill('confidence', row.confidence);
    fill('phone', row.phone);
    fill('website', row.website);
    fill('email', row.email);
    fill('socials', row.socials_json);
    // Freshness-bearing fields overwrite when the incoming pull is newer.
    if (fetchedAt >= row.fetched_at) {
      if (fields.rating !== undefined) out.rating = fields.rating;
      if (fields.rating_count !== undefined) out.rating_count = fields.rating_count;
      if (fields.opening_hours_osm !== undefined) out.opening_hours_osm = fields.opening_hours_osm;
      if (fields.open_24h !== undefined) out.open_24h = fields.open_24h;
      if (fields.price_min_vnd !== undefined) out.price_min_vnd = fields.price_min_vnd;
      if (fields.price_max_vnd !== undefined) out.price_max_vnd = fields.price_max_vnd;
      if (fields.price_band !== undefined) out.price_band = fields.price_band;
      if (fields.price_raw !== undefined) out.price_raw = fields.price_raw;
    }
    fill('amenities', row.amenities_json);
    fill('images', row.images_json);
    fill('menu_images', row.menu_images_json);
    fill('thumbnail', row.thumbnail);
    fill('streetview_thumb', row.streetview_thumb);
    fill('popular_times', row.popular_times_json);
    fill('description', row.description);
    fill('plus_code', row.plus_code);
    return out;
  }

  /** Hours/price go stale; identity doesn't. Null when the row has neither. */
  private staleAt(fetchedAt: number, fields: VenueFields): number | null {
    const decaying = fields.opening_hours_osm !== undefined || fields.price_band !== undefined || fields.rating !== undefined;
    return decaying ? fetchedAt + STALE_TTL_MS : null;
  }

  // ── read faces ────────────────────────────────────────────────────────────

  /**
   * Local search — the zero-cost front row of the places seam. Returns rows
   * shaped like a provider result (`local:<id>` osm_id) carrying the
   * enrichment fields providers don't have, so a pin from a hit arrives
   * already rich.
   */
  search(query: string, bias?: { lat: number; lng: number; radius?: number }, limit = 10): Record<string, unknown>[] {
    const norm = normalizeVnName(query);
    const tokens = norm.split(' ').filter((t) => t.length > 0);
    let rows: VenueRow[];
    if (tokens.length > 0) {
      const ftsQuery = tokens.map((t) => `"${t.replace(/"/g, '')}"*`).join(' AND ');
      rows = this.repo.search(ftsQuery, limit * 4);
    } else {
      rows = [];
    }

    if (bias && rows.length > 0) {
      rows = rows
        .map((r) => ({ r, d: haversineMetres(r.lat, r.lng, bias.lat, bias.lng) }))
        .filter((x) => bias.radius === undefined || x.d <= bias.radius)
        .sort((a, b) => a.d - b.d)
        .map((x) => x.r);
    }
    return rows.slice(0, limit).map((r) => this.toSearchRecord(r));
  }

  /** ProviderPlace-shaped record the maps seam merges with index/OSM hits. */
  toSearchRecord(v: VenueRow): Record<string, unknown> {
    const categories = v.categories_json ? (JSON.parse(v.categories_json) as string[]) : [];
    return {
      google_place_id: null,
      google_ftid: null,
      osm_id: `local:${v.id}`,
      name: v.name,
      address: v.address_freeform ?? [v.address_ward, v.address_district, v.address_city].filter(Boolean).join(', '),
      lat: v.lat,
      lng: v.lng,
      rating: v.rating,
      rating_count: v.rating_count,
      website: v.website,
      phone: v.phone,
      email: v.email,
      category: v.category_primary ?? categories[0] ?? null,
      brand: v.brand,
      opening_hours_osm: v.opening_hours_osm,
      open_24h: v.open_24h === 1,
      price_band: v.price_band,
      price_range: v.price_raw,
      // Photo URLs keep the Google size suffix; callers rewrite it for the
      // pixel size they need (=w1200-h900 for cards, =s1600 for full view).
      thumbnail: v.thumbnail,
      streetview_thumb: v.streetview_thumb,
      menu_images: v.menu_images_json ? JSON.parse(v.menu_images_json) : null,
      amenities: v.amenities_json ? JSON.parse(v.amenities_json) : null,
      description: v.description,
      source: 'local-venues',
    };
  }

  /**
   * Snapshot enrichment for the decision flow: find the venue matching a
   * candidate's ids/position and return the fields the place row lacks.
   * Cheapest resolver upgrade — one local read replaces a provider call.
   */
  enrichForCandidate(args: {
    google_place_id?: string | null;
    osm_id?: string | null;
    vietmap_ref_id?: string | null;
    name?: string | null;
    lat?: number | null;
    lng?: number | null;
    phone?: string | null;
  }): Partial<VenueFields> | null {
    const venue = this.findForCandidate(args);
    if (!venue) return null;
    return venueToFields(venue);
  }

  findForCandidate(args: {
    google_place_id?: string | null;
    osm_id?: string | null;
    vietmap_ref_id?: string | null;
    name?: string | null;
    lat?: number | null;
    lng?: number | null;
    phone?: string | null;
  }): VenueRow | null {
    for (const id of [args.google_place_id, args.osm_id, args.vietmap_ref_id]) {
      if (typeof id === 'string' && id.length > 0) {
        const vid = this.repo.findVenueByAnyExternalId(id.startsWith('local:') ? id.slice(6) : id);
        if (vid !== null) return this.repo.getVenue(vid);
        // A `local:<id>` pick carries the venue id itself.
        if (id.startsWith('local:')) {
          const direct = this.repo.getVenue(Number(id.slice(6)));
          if (direct) return direct;
        }
      }
    }
    if (typeof args.lat === 'number' && typeof args.lng === 'number' && typeof args.name === 'string') {
      const norm = normalizeVnName(args.name);
      for (const v of this.candidatesNear(args.lat, args.lng)) {
        if (haversineMetres(v.lat, v.lng, args.lat, args.lng) > MATCH_RADIUS_M) continue;
        if (nameSimilarity(norm, v.name_normalized) >= NAME_SIM_STRONG) return v;
      }
    }
    const phone = normalizePhone(args.phone);
    if (phone && typeof args.lat === 'number' && typeof args.lng === 'number') {
      for (const v of this.candidatesNear(args.lat, args.lng)) {
        if (v.phone && normalizePhone(v.phone) === phone) return v;
      }
    }
    return null;
  }

  findById(id: number): VenueRow | null {
    return Number.isInteger(id) ? this.repo.getVenue(id) : null;
  }

  count(): number {
    return this.repo.countVenues();
  }
}

/** Flatten a canonical row back to the fields merge/snapshot layers use. */
export function venueToFields(v: VenueRow): VenueFields {
  return {
    name: v.name,
    lat: v.lat,
    lng: v.lng,
    address_freeform: v.address_freeform,
    categories: v.categories_json ? (JSON.parse(v.categories_json) as string[]) : null,
    category_primary: v.category_primary,
    brand: v.brand,
    phone: v.phone,
    website: v.website,
    email: v.email,
    rating: v.rating,
    rating_count: v.rating_count,
    price_raw: v.price_raw,
    price_min_vnd: v.price_min_vnd,
    price_max_vnd: v.price_max_vnd,
    price_band: v.price_band,
    opening_hours_osm: v.opening_hours_osm,
    open_24h: v.open_24h === 1,
    amenities: v.amenities_json ? (JSON.parse(v.amenities_json) as Record<string, boolean>) : null,
    images: v.images_json ? (JSON.parse(v.images_json) as string[]) : null,
    menu_images: v.menu_images_json ? (JSON.parse(v.menu_images_json) as string[]) : null,
    thumbnail: v.thumbnail,
    streetview_thumb: v.streetview_thumb,
    description: v.description,
  };
}

/** Google-scrape row → canonical fields. Lives here because the payload
 *  dialect (VN day names, dirty price, about sections) is exactly what the
 *  normalizers know; a new source adds its own extractor beside this one. */
export function fieldsFromGoogleScrape(r: Record<string, unknown>): VenueFields {
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const strArr = (v: unknown): string[] | null =>
    Array.isArray(v) ? (v.filter((x) => typeof x === 'string' && x.trim()) as string[]) : null;

  const categories = strArr(r.categories) ?? (str(r.category) ? [str(r.category)!] : null);
  const images = (Array.isArray(r.images) ? r.images : [])
    .map((i) => (i && typeof i === 'object' ? (i as { image?: unknown }).image : null))
    .filter((u): u is string => typeof u === 'string');
  // Menu album entries split out — the resolver/UI ask for them separately.
  const menuImages = (Array.isArray(r.images) ? r.images : [])
    .filter((i) => i && typeof i === 'object')
    .filter((i) => /thuc don|menu/i.test(normalizeVnName(String((i as { title?: unknown }).title ?? ''))))
    .map((i) => (i as { image?: unknown }).image)
    .filter((u): u is string => typeof u === 'string');

  const hours = parseVnOpenHours(r.open_hours);
  const price = parseVnPriceRange(r.price_range);
  const thumbnail = str(r.thumbnail);
  const isStreetview = thumbnail !== null && thumbnail.includes('streetviewpixels');
  // The same photo URL serves any size — callers rewrite the =wXX-hYY suffix.
  // Thumbnails that are Street View panoramas are not venue photos.

  return {
    name: str(r.title),
    lat: num(r.latitude),
    lng: num(r.longitude ?? r.longtitude),
    address_freeform: str(r.address) ?? str(r.complete_address),
    categories,
    category_primary: normalizeVnCategory(categories),
    phone: str(r.phone),
    website: str(r.web_site),
    rating: num(r.review_rating),
    rating_count: num(r.review_count),
    price_raw: str(r.price_range),
    price_min_vnd: price?.minVnd ?? null,
    price_max_vnd: price?.maxVnd ?? null,
    price_band: price?.band ?? null,
    opening_hours_osm: hours?.osm ?? null,
    open_24h: hours?.open24h ?? false,
    amenities: aboutToAmenities(r.about),
    images: images.length > 0 ? images : null,
    menu_images: menuImages.length > 0 ? menuImages : null,
    thumbnail: isStreetview ? null : thumbnail,
    streetview_thumb: isStreetview ? thumbnail : null,
    popular_times:
      r.popular_times && typeof r.popular_times === 'object'
        ? (r.popular_times as Record<string, unknown>)
        : null,
    description: str(r.description),
    plus_code: str(r.plus_code),
  };
}
