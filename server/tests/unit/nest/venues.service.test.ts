import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb, resetTestDb } from '../../helpers/test-db';
import { DatabaseService } from '../../../src/nest/database/database.service';
import { VenuesService, fieldsFromGoogleScrape, venueToFields } from '../../../src/nest/venues/venues.service';
import { VenuesRepository } from '../../../src/nest/venues/venues.repository';
import {
  normalizeVnName,
  nameSimilarity,
  geohash6,
  geohashNeighbours,
  haversineMetres,
  parseVnOpenHours,
  parseVnPriceRange,
  aboutToAmenities,
  normalizeVnCategory,
  normalizePhone,
} from '../../../src/nest/venues/venue-normalize';

/**
 * The proprietary venues store: VN text normalization, scraped-field parsers,
 * entity matching and the ingest pipeline — all against a real test DB.
 */

let testDb: Database.Database;
let svc: VenuesService;

beforeEach(() => {
  testDb = createTestDb();
  resetTestDb(testDb);
  const db = new DatabaseService(testDb);
  svc = new VenuesService(new VenuesRepository(db));
});

afterAll(() => {
  testDb?.close();
});

// ── normalization primitives ────────────────────────────────────────────────

describe('normalizeVnName', () => {
  it('strips diacritics, lowercases, collapses punctuation', () => {
    expect(normalizeVnName('Cà Phê Đặng — Quán!')).toBe('ca phe dang quan');
    expect(normalizeVnName('Highlands Coffee Nguyễn Huệ')).toBe('highlands coffee nguyen hue');
  });
});

describe('nameSimilarity', () => {
  it('scores shared tokens over the shorter name', () => {
    expect(nameSimilarity('cafe son thuy', 'son thuy cafe')).toBe(1);
    expect(nameSimilarity('cafe son thuy', 'son thuy coffee')).toBeGreaterThanOrEqual(0.6);
    expect(nameSimilarity('cafe a', 'quan b')).toBe(0);
    expect(nameSimilarity('the coffee house hoan kiem', 'coffee house hoan kiem')).toBeCloseTo(1);
  });
});

describe('geohash6 / haversine', () => {
  it('co-located points share a cell; neighbours cover the 9-cell ring', () => {
    const a = geohash6(21.030001, 105.850001);
    const b = geohash6(21.03009, 105.85009);
    expect(a).toBe(b);
    const ring = geohashNeighbours(a);
    expect(ring).toHaveLength(8);
    expect(ring).not.toContain(a);
  });

  it('haversineMetres is sane for a known HN leg', () => {
    const d = haversineMetres(21.0285, 105.8542, 21.033, 105.85);
    expect(d).toBeGreaterThan(400);
    expect(d).toBeLessThan(1200);
  });
});

// ── scraped-field parsers ───────────────────────────────────────────────────

describe('parseVnOpenHours', () => {
  it('maps VN day names to OSM and groups identical ranges', () => {
    const out = parseVnOpenHours({
      'Thứ Hai': ['07:00–22:00'],
      'Thứ Ba': ['07:00–22:00'],
      'Thứ Tư': ['07:00–22:00'],
      'Thứ Năm': ['07:00–22:00'],
      'Thứ Sáu': ['07:00–22:00'],
      'Thứ Bảy': ['08:00–23:00'],
      'Chủ Nhật': ['08:00–23:00'],
    });
    expect(out).not.toBeNull();
    expect(out!.osm).toBe('Mo-Fr 07:00-22:00; Sa,Su 08:00-23:00');
    expect(out!.open24h).toBe(false);
  });

  it('"Mở cửa cả ngày" becomes the 24/7 sentinel', () => {
    const out = parseVnOpenHours({ 'Thứ Hai': ['Mở cửa cả ngày'], 'Thứ Ba': ['Mở cửa cả ngày'] });
    expect(out).toEqual({ osm: '24/7', open24h: true });
  });

  it('skips closed days and garbage values', () => {
    const out = parseVnOpenHours({ 'Thứ Hai': ['Đóng cửa'], 'Thứ Ba': ['09:00–17:00'], junk: ['x'] });
    expect(out!.osm).toBe('Tu 09:00-17:00');
  });

  it('returns null when nothing parses', () => {
    expect(parseVnOpenHours({ 'Thứ Hai': [] })).toBeNull();
    expect(parseVnOpenHours('nope')).toBeNull();
  });
});

describe('parseVnPriceRange', () => {
  it('reads thousand-VND shorthand and dot separators', () => {
    expect(parseVnPriceRange('100-200N ₫')).toEqual({ minVnd: 100_000, maxVnd: 200_000, band: 'HIGH' });
    expect(parseVnPriceRange('₫20.000-40.000')).toEqual({ minVnd: 20_000, maxVnd: 40_000, band: 'LOW' });
    expect(parseVnPriceRange('50000')).toEqual({ minVnd: 50_000, maxVnd: 50_000, band: 'MEDIUM' });
  });

  it('returns null on empty/non-numeric input', () => {
    expect(parseVnPriceRange('₫₫₫')).toBeNull();
    expect(parseVnPriceRange(42)).toBeNull();
  });
});

describe('aboutToAmenities', () => {
  it('flattens enabled VN option names to amenity keys', () => {
    const out = aboutToAmenities([
      { name: 'Tiện nghi', options: [{ name: 'Chỗ ngồi ngoài trời', enabled: true }, { name: 'Wi-Fi', enabled: false }] },
      { name: 'Không gian', options: [{ name: 'Nhóm', enabled: true }, { name: 'Phù hợp cho trẻ em', enabled: true }] },
    ]);
    expect(out).toMatchObject({ outdoor_seating: true, good_for_groups: true, family_friendly: true });
    expect(out!.wifi).toBeUndefined();
  });

  it('null when the shape is absent', () => {
    expect(aboutToAmenities(null)).toBeNull();
    expect(aboutToAmenities([{ name: 'x' }])).toBeNull();
  });
});

describe('normalizePhone / normalizeVnCategory', () => {
  it('canonicalizes VN phone to +84', () => {
    expect(normalizePhone('0901 234 567')).toBe('+84901234567');
    expect(normalizePhone('+84 901-234-567')).toBe('+84901234567');
    expect(normalizePhone('')).toBeNull();
  });

  it('maps VN category strings onto the resolver taxonomy', () => {
    expect(normalizeVnCategory(['Quán cà phê'])).toBe('cafe');
    expect(normalizeVnCategory(['Trà sữa', 'Quán cà phê'])).toBe('tra_sua');
    expect(normalizeVnCategory(['Bierhaus'])).toBeNull();
    expect(normalizeVnCategory([])).toBeNull();
  });
});

// ── ingest + entity matching ────────────────────────────────────────────────

const HN = { lat: 21.0285, lng: 105.8542 };

function scrapeRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Cafe Test',
    latitude: HN.lat,
    longitude: HN.lng,
    address: '1 P. Test, Hoàn Kiếm',
    place_id: 'pid-1',
    review_rating: 4.5,
    review_count: 120,
    open_hours: { 'Thứ Hai': ['07:00–22:00'] },
    price_range: '20.000-50.000₫',
    categories: ['Quán cà phê'],
    phone: '0901234567',
    web_site: 'https://cafe.example',
    thumbnail: 'https://lh3.googleusercontent.com/x=w426-h240-k-no',
    images: [{ title: 'Ảnh', image: 'https://lh3.googleusercontent.com/a=w100' }],
    ...over,
  };
}

describe('VenuesService.ingest', () => {
  it('creates a venue + append-only observation on first sight', () => {
    const res = svc.ingest(
      { source: 'google_scrape', externalId: 'pid-1', payload: scrapeRow(), licenseTag: 'x', fetchedAt: 1000 },
      fieldsFromGoogleScrape(scrapeRow()),
    );
    expect(res.matched).toBe('new');
    const venue = svc.findById(res.venueId);
    expect(venue!.name).toBe('Cafe Test');
    expect(venue!.rating).toBe(4.5);
    expect(venue!.price_band).toBe('MEDIUM');
    const obs = testDb.prepare('SELECT COUNT(*) n, MIN(venue_id) v FROM venue_observations').get() as { n: number; v: number };
    expect(obs.n).toBe(1);
    expect(obs.v).toBe(res.venueId);
  });

  it('re-ingesting the same external id merges onto the same venue', () => {
    const first = svc.ingest({ source: 'google_scrape', externalId: 'pid-1', payload: scrapeRow(), licenseTag: 'x', fetchedAt: 1000 }, fieldsFromGoogleScrape(scrapeRow()));
    const second = svc.ingest(
      { source: 'trackasia', externalId: 'pid-1', payload: scrapeRow({ web_site: 'https://new.example' }), licenseTag: 'x', fetchedAt: 2000 },
      fieldsFromGoogleScrape(scrapeRow({ web_site: 'https://new.example' })),
    );
    expect(second.venueId).toBe(first.venueId);
    expect(second.matched).toBe('external_id');
    // Website already known → null-fill keeps the original.
    expect(svc.findById(first.venueId)!.website).toBe('https://cafe.example');
    expect(testDb.prepare('SELECT COUNT(*) n FROM venue_observations').get()).toEqual({ n: 2 });
  });

  it('merges a different-source record on geo + name when ids differ', () => {
    const first = svc.ingest({ source: 'google_scrape', externalId: 'pid-1', payload: scrapeRow(), licenseTag: 'x', fetchedAt: 1000 }, fieldsFromGoogleScrape(scrapeRow()));
    const near = scrapeRow({ title: 'Café Test', latitude: HN.lat + 0.0002, longitude: HN.lng + 0.0001, phone: '0909999999' });
    const res = svc.ingest({ source: 'trackasia', externalId: 'ta-9', payload: near, licenseTag: 'x', fetchedAt: 1500 }, fieldsFromGoogleScrape(near));
    expect(res.venueId).toBe(first.venueId);
    expect(res.matched).toBe('geo_name');
  });

  it('keeps an observation without venue when identity fields are missing', () => {
    const res = svc.ingest({ source: 'google_scrape', externalId: 'pid-x', payload: { note: 'no coords' }, licenseTag: 'x', fetchedAt: 1000 }, {});
    expect(res.venueId).toBe(-1);
    expect(testDb.prepare('SELECT COUNT(*) n FROM venue_observations WHERE venue_id IS NULL').get()).toEqual({ n: 1 });
  });
});

describe('search + enrichment', () => {
  function ingest(row: Record<string, unknown>, extId = 'pid-1') {
    return svc.ingest({ source: 'google_scrape', externalId: extId, payload: row, licenseTag: 'x', fetchedAt: 1000 }, fieldsFromGoogleScrape(row));
  }

  it('FTS search matches normalized VN names and returns a provider-shaped record', () => {
    ingest(scrapeRow({ title: 'Cà Phê Đặng' }));
    const hits = svc.search('ca phe dang');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.osm_id).toMatch(/^local:\d+$/);
    expect(hits[0]!.rating).toBe(4.5);
    expect(hits[0]!.opening_hours_osm).toBe('Mo 07:00-22:00');
  });

  it('bias sorts nearer hits first', () => {
    ingest(scrapeRow({ title: 'Cafe Far', latitude: HN.lat + 0.05, longitude: HN.lng + 0.05 }), 'pid-far');
    ingest(scrapeRow(), 'pid-near');
    const hits = svc.search('cafe', { lat: HN.lat, lng: HN.lng });
    expect(hits[0]!.name).toBe('Cafe Test');
  });

  it('enrichForCandidate resolves by local: id and by geo+name', () => {
    const res = ingest(scrapeRow());
    expect(svc.enrichForCandidate({ osm_id: `local:${res.venueId}` })!.name).toBe('Cafe Test');
    const byGeo = svc.enrichForCandidate({ name: 'Cafe Test', lat: HN.lat + 0.0001, lng: HN.lng });
    expect(byGeo).not.toBeNull();
    expect(byGeo!.rating).toBe(4.5);
    expect(svc.enrichForCandidate({ name: 'Elsewhere', lat: 10.7, lng: 106.6 })).toBeNull();
  });
});

describe('fieldsFromGoogleScrape', () => {
  it('splits menu album, streetview thumbs and survives the longtitude typo', () => {
    const row = scrapeRow({
      longtitude: HN.lng, // typo'd column carries the real value
      longitude: undefined,
      thumbnail: 'https://streetviewpixels-pa.googleapis.com/v1/thumbnail?panoid=abc',
      images: [
        { title: 'Thực đơn', image: 'https://lh3.googleusercontent.com/menu=w100' },
        { title: 'Không gian', image: 'https://lh3.googleusercontent.com/space=w100' },
      ],
    });
    const f = fieldsFromGoogleScrape(row);
    expect(f.lng).toBe(HN.lng);
    expect(f.menu_images).toEqual(['https://lh3.googleusercontent.com/menu=w100']);
    expect(f.images).toHaveLength(2);
    expect(f.thumbnail).toBeNull();
    expect(f.streetview_thumb).toContain('streetviewpixels');
    expect(f.category_primary).toBe('cafe');
  });
});

describe('venueToFields round-trip', () => {
  it('flattens a stored row back to fields for snapshot merge', () => {
    const res = svc.ingest({ source: 'google_scrape', externalId: 'pid-1', payload: scrapeRow(), licenseTag: 'x', fetchedAt: 1000 }, fieldsFromGoogleScrape(scrapeRow()));
    const fields = venueToFields(svc.findById(res.venueId)!);
    expect(fields.name).toBe('Cafe Test');
    expect(fields.categories).toContain('Quán cà phê');
    expect(fields.open_24h).toBe(false);
  });
});

// ── merge semantics + remaining branches ────────────────────────────────────

describe('merge semantics', () => {
  it('null-fill contributes new columns; freshness fields refresh on newer pulls', () => {
    const first = svc.ingest(
      { source: 'a', externalId: 'x-1', payload: {}, licenseTag: 'x', fetchedAt: 1000 },
      { name: 'Cafe X', lat: HN.lat, lng: HN.lng, rating: 4.0 },
    );
    const second = svc.ingest(
      { source: 'b', externalId: 'x-1', payload: {}, licenseTag: 'x', fetchedAt: 2000 },
      {
        name: 'Cafe X', lat: HN.lat, lng: HN.lng,
        rating: 4.6, rating_count: 88, price_band: 'LOW', price_min_vnd: 15_000, price_max_vnd: 40_000,
        price_raw: '15-40k', opening_hours_osm: 'Mo-Su 07:00-22:00', open_24h: false,
        phone: '0902222333', website: 'https://x.example', email: 'hi@x.example', socials: ['https://fb/x'],
        brand: 'X', confidence: 0.9, address_ward: 'P. Test', address_district: 'Q. Test',
        address_city: 'Hà Nội', categories: ['Quán cà phê'], category_primary: 'cafe',
        amenities: { wifi: true }, images: ['https://img/1'], menu_images: ['https://img/menu'],
        thumbnail: 'https://img/thumb', streetview_thumb: 'https://sv/thumb',
        popular_times: { Monday: [] }, description: 'nice', plus_code: 'ABC+12',
      },
    );
    expect(second.venueId).toBe(first.venueId);
    const v = svc.findById(first.venueId)!;
    expect(v.rating).toBe(4.6);              // freshness overwrites
    expect(v.phone).toBe('0902222333');      // null-fill contributes
    expect(v.amenities_json).toContain('wifi');
    expect(v.menu_images_json).toContain('menu');
    expect(v.plus_code).toBe('ABC+12');
    expect(v.categories_json).toContain('Quán cà phê');
    // Name change on merge resyncs the FTS row.
    expect(svc.search('cafe x').length).toBeGreaterThan(0);
  });

  it('stale_at is only set when freshness-bearing fields were seen', () => {
    const rich = svc.ingest(
      { source: 'a', externalId: 'x-2', payload: {}, licenseTag: 'x', fetchedAt: 1000 },
      { name: 'Rich', lat: HN.lat, lng: HN.lng, rating: 4 },
    );
    const bare = svc.ingest(
      { source: 'a', externalId: 'x-3', payload: {}, licenseTag: 'x', fetchedAt: 1000 },
      { name: 'Bare', lat: HN.lat + 0.002, lng: HN.lng + 0.002 },
    );
    expect(svc.findById(rich.venueId)!.stale_at).toBe(1000 + 90 * 24 * 3600 * 1000);
    expect(svc.findById(bare.venueId)!.stale_at).toBeNull();
  });

  it('an older pull does not clobber freshness fields', () => {
    const first = svc.ingest(
      { source: 'a', externalId: 'x-4', payload: {}, licenseTag: 'x', fetchedAt: 2000 },
      { name: 'Old Fresh', lat: HN.lat, lng: HN.lng, rating: 4.8 },
    );
    svc.ingest(
      { source: 'b', externalId: 'x-4', payload: {}, licenseTag: 'x', fetchedAt: 1000 },
      { name: 'Old Fresh', lat: HN.lat, lng: HN.lng, rating: 1.0 },
    );
    expect(svc.findById(first.venueId)!.rating).toBe(4.8);
  });
});

describe('matching — phone + weak geo_name tiers', () => {
  it('same phone in the same cell joins even with a different name', () => {
    const first = svc.ingest(
      { source: 'a', externalId: 'p-1', payload: {}, licenseTag: 'x', fetchedAt: 1000 },
      { name: 'Totally Different', lat: HN.lat, lng: HN.lng, phone: '0901234567' },
    );
    const res = svc.ingest(
      { source: 'b', externalId: 'p-2', payload: {}, licenseTag: 'x', fetchedAt: 1500 },
      { name: 'Quán Không Giống', lat: HN.lat + 0.0001, lng: HN.lng, phone: '+84 901 234 567' },
    );
    expect(res.venueId).toBe(first.venueId);
    expect(res.matched).toBe('phone');
  });

  it('weak name similarity needs a shared category to merge', () => {
    const first = svc.ingest(
      { source: 'a', externalId: 'g-1', payload: {}, licenseTag: 'x', fetchedAt: 1000 },
      { name: 'Cafe Alpha One', lat: HN.lat, lng: HN.lng, category_primary: 'cafe' },
    );
    const weak = svc.ingest(
      { source: 'b', externalId: 'g-2', payload: {}, licenseTag: 'x', fetchedAt: 1500 },
      { name: 'Cafe Alpha Bakery', lat: HN.lat + 0.0001, lng: HN.lng, category_primary: 'cafe' },
    );
    expect(weak.venueId).toBe(first.venueId);
    expect(weak.matched).toBe('geo_name');

    const noCat = svc.ingest(
      { source: 'b', externalId: 'g-3', payload: {}, licenseTag: 'x', fetchedAt: 1600 },
      { name: 'Cafe Delta Bakery', lat: HN.lat + 0.0002, lng: HN.lng, category_primary: 'restaurant' },
    );
    expect(noCat.matched).toBe('new');
  });

  it('enrichForCandidate resolves via phone and arbitrary provider ids', () => {
    svc.ingest(
      { source: 'google_scrape', externalId: 'pid-1', payload: scrapeRow(), licenseTag: 'x', fetchedAt: 1000 },
      fieldsFromGoogleScrape(scrapeRow()),
    );
    expect(svc.enrichForCandidate({ google_place_id: 'pid-1' })!.name).toBe('Cafe Test');
    expect(
      svc.enrichForCandidate({ vietmap_ref_id: 'unmatched', name: 'Cafe Test', lat: HN.lat, lng: HN.lng, phone: '0901234567' })!.name,
    ).toBe('Cafe Test');
  });
});

describe('search edge cases', () => {
  it('empty query yields nothing; radius excludes far hits', () => {
    svc.ingest({ source: 'a', externalId: 's-1', payload: scrapeRow(), licenseTag: 'x', fetchedAt: 1000 }, fieldsFromGoogleScrape(scrapeRow()));
    expect(svc.search('')).toEqual([]);
    const hits = svc.search('cafe', { lat: HN.lat + 0.3, lng: HN.lng + 0.3, radius: 1000 });
    expect(hits).toEqual([]);
    expect(svc.count()).toBe(1);
    expect(svc.findById(0)).toBeNull();
  });
});

describe('repository direct paths', () => {
  it('searchNear lists rows in the cell ring', () => {
    const repo = new VenuesRepository(new DatabaseService(testDb));
    svc.ingest({ source: 'a', externalId: 'r-1', payload: scrapeRow(), licenseTag: 'x', fetchedAt: 1000 }, fieldsFromGoogleScrape(scrapeRow()));
    const cell = geohash6(HN.lat, HN.lng);
    const near = repo.searchNear(HN.lat, HN.lng, [cell, ...geohashNeighbours(cell)], 10);
    expect(near).toHaveLength(1);
    expect(repo.searchNear(HN.lat, HN.lng, [], 10)).toEqual([]);
  });
});

describe('parser edge branches', () => {
  it('open hours: dotted times, 00:00–24:00, mixed days', () => {
    const out = parseVnOpenHours({ 'Thứ Hai': ['7.30–22.00'], 'Thứ Ba': ['00:00–24:00'], 'Thứ Tư': '07:00–12:00' });
    expect(out!.osm).toContain('Mo 07:30-22:00');
    expect(out!.open24h).toBe(true);
    expect(out!.osm).toContain('We 07:00-12:00');
  });

  it('price: mixed-unit range "1-100.000 ₫" and single token', () => {
    expect(parseVnPriceRange('1-100.000 ₫')).toEqual({ minVnd: 1_000, maxVnd: 100_000, band: 'MEDIUM' });
    expect(parseVnPriceRange('75n')).toEqual({ minVnd: 75_000, maxVnd: 75_000, band: 'MEDIUM' });
  });

  it('about: guards skip non-objects, disabled and unmapped options', () => {
    const out = aboutToAmenities([
      'garbage',
      { name: 'x', options: 'not-an-array' },
      { name: 'y', options: [null, { name: 42, enabled: true }, { name: 'Wi-Fi', enabled: false }, { name: 'Không map gì', enabled: true }] },
    ]);
    expect(out).toBeNull();
  });

  it('category: non-string entries are skipped', () => {
    expect(normalizeVnCategory([42, null, 'Trà sữa'])).toBe('tra_sua');
    expect(normalizeVnCategory('not-array')).toBeNull();
  });

  it('scrape extractor: single category string and non-object images', () => {
    const f = fieldsFromGoogleScrape({ title: 'T', latitude: 1, longitude: 2, category: 'Quán cà phê', images: ['bare', { image: 'u' }] });
    expect(f.categories).toEqual(['Quán cà phê']);
    expect(f.images).toEqual(['u']);
  });
});

describe('review-derived freshness (status column is unusable)', () => {
  it('rating 0 stores null, not a fake zero — and the count follows it', () => {
    const f = fieldsFromGoogleScrape(scrapeRow({ review_rating: 0, review_count: 0 }));
    expect(f.rating).toBeNull();
    expect(f.rating_count).toBeNull();
  });

  it('extractGoogleReviews: newest review sets last_review_at, text reviews become excerpts', () => {
    const f = fieldsFromGoogleScrape(
      scrapeRow({
        user_reviews: [
          { Name: 'An', Rating: 5, Description: 'Quán đẹp', published_at: '2025-01-01T00:00:00Z' },
          { Name: 'Bình', Rating: 4, Description: '', published_at: '2026-01-01T00:00:00Z' },
          { Name: 'Chi', Rating: 3, Description: 'Đồ uống ok', published_at: '2025-06-01T00:00:00Z' },
        ],
      }),
    );
    expect(f.last_review_at).toBe(Math.floor(Date.parse('2026-01-01T00:00:00Z') / 1000));
    expect(f.top_reviews).toHaveLength(2);
    expect(f.top_reviews![0]!.text).toBe('Đồ uống ok');
  });

  it('merge keeps the newest last_review_at — an older scrape must not clobber it', () => {
    const newer = scrapeRow({
      user_reviews: [{ Name: 'A', Rating: 5, Description: 'mới', published_at: '2026-01-01T00:00:00Z' }],
    });
    const older = scrapeRow({
      user_reviews: [{ Name: 'B', Rating: 1, Description: 'cũ', published_at: '2024-01-01T00:00:00Z' }],
    });
    const first = svc.ingest(
      { source: 'google_scrape', externalId: 'pid-1', payload: newer, licenseTag: 'x', fetchedAt: 2000 },
      fieldsFromGoogleScrape(newer),
    );
    svc.ingest(
      { source: 'trackasia', externalId: 'pid-1', payload: older, licenseTag: 'x', fetchedAt: 3000 },
      fieldsFromGoogleScrape(older),
    );
    const v = svc.findById(first.venueId)!;
    expect(v.last_review_at).toBe(Math.floor(Date.parse('2026-01-01T00:00:00Z') / 1000));
    expect(JSON.parse(v.top_reviews_json!)[0].text).toBe('mới');
  });

  it('search records carry review freshness for the venue card', () => {
    svc.ingest(
      { source: 'google_scrape', externalId: 'pid-1', payload: scrapeRow(), licenseTag: 'x', fetchedAt: 1000 },
      fieldsFromGoogleScrape(
        scrapeRow({
          title: 'Cà Phê Test',
          user_reviews: [{ Name: 'A', Rating: 5, Description: 'ngon', published_at: '2026-02-01T00:00:00Z' }],
        }),
      ),
    );
    const hits = svc.search('ca phe');
    expect(hits[0]!.last_review_at).toBe(Math.floor(Date.parse('2026-02-01T00:00:00Z') / 1000));
    expect((hits[0]!.top_reviews as { text: string }[])[0]!.text).toBe('ngon');
  });
});
