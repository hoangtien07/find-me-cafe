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
