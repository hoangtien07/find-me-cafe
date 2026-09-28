/**
 * Pure normalizers for the venues database — Vietnamese source data in,
 * canonical values out. Nothing here touches the DB or the network, which is
 * what makes every function cheap to test against real scraped rows.
 */

// ── Names ───────────────────────────────────────────────────────────────────

/**
 * Lowercase, strip combining marks, fold đ/Đ → d, collapse non-alnum into
 * single spaces. Used for both the FTS column and the geo+name match, so it
 * must be deterministic across sources that spell "Quán" / "quan" / "QUÁN"
 * differently.
 */
export function normalizeVnName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Token-set overlap coefficient: |common| / min(|a|, |b|). */
export function nameSimilarity(a: string, b: string): number {
  const wa = new Set(a.split(' ').filter((w) => w.length > 0));
  const wb = new Set(b.split(' ').filter((w) => w.length > 0));
  if (wa.size === 0 || wb.size === 0) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / Math.min(wa.size, wb.size);
}

// ── Geohash ─────────────────────────────────────────────────────────────────

const GEOHASH_CHARS = '0123456789bcdefghjkmnpqrstuvwxyz';

/** Standard geohash encoding, 6 chars ≈ ±0.61×0.61 km cell. */
export function geohash6(lat: number, lng: number): string {
  let latLo = -90, latHi = 90, lngLo = -180, lngHi = 180;
  let bits = '', isLng = true, count = 0;
  while (count < 6) {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      value <<= 1;
      if (isLng) {
        const mid = (lngLo + lngHi) / 2;
        if (lng >= mid) { value |= 1; lngLo = mid; } else { lngHi = mid; }
      } else {
        const mid = (latLo + latHi) / 2;
        if (lat >= mid) { value |= 1; latLo = mid; } else { latHi = mid; }
      }
      isLng = !isLng;
    }
    bits += GEOHASH_CHARS[value];
    count++;
  }
  return bits;
}

/**
 * The 8 neighbour cells of a geohash — venues ~50 m apart can sit across a
 * cell edge, so matching must look at the ring too.
 */
export function geohashNeighbours(hash: string): string[] {
  const row = hash;
  const out = new Set<string>();
  // Encode the cell centre and 8 offsets of one cell step at this precision.
  const { lat, lng } = geohashDecode(row);
  const latStep = 180 / Math.pow(2, Math.floor((row.length * 5) / 2));
  const lngStep = 360 / Math.pow(2, Math.ceil((row.length * 5) / 2));
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dy === 0 && dx === 0) continue;
      out.add(geohash6(lat + dy * latStep, lng + dx * lngStep));
    }
  }
  return [...out];
}

function geohashDecode(hash: string): { lat: number; lng: number } {
  let latLo = -90, latHi = 90, lngLo = -180, lngHi = 180, isLng = true;
  for (const ch of hash) {
    const value = GEOHASH_CHARS.indexOf(ch);
    for (let i = 4; i >= 0; i--) {
      const bit = (value >> i) & 1;
      if (isLng) {
        const mid = (lngLo + lngHi) / 2;
        if (bit) lngLo = mid; else lngHi = mid;
      } else {
        const mid = (latLo + latHi) / 2;
        if (bit) latLo = mid; else latHi = mid;
      }
      isLng = !isLng;
    }
  }
  return { lat: (latLo + latHi) / 2, lng: (lngLo + lngHi) / 2 };
}

/** WGS-84 haversine in metres. */
export function haversineMetres(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ── Opening hours (scraped VN format → OSM) ────────────────────────────────

const VN_DAY_TO_OSM: Record<string, string> = {
  'thu hai': 'Mo',
  'thu ba': 'Tu',
  'thu tu': 'We',
  'thu nam': 'Th',
  'thu sau': 'Fr',
  'thu bay': 'Sa',
  'chu nhat': 'Su',
};
const OSM_DAY_ORDER = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] as const;

/**
 * Scraped `open_hours` is `{"Thứ Hai": ["09:00–23:30"], "Chủ Nhật": [...]}` —
 * VN day names, en-dash ranges, plus sentinels ("Mở cửa cả ngày" = 24/7,
 * "Đóng cửa" = closed that day). Emits OSM `opening_hours` syntax with
 * identical ranges grouped (`Mo-Su 09:00-23:30`) so the resolver's hours
 * parser reads it without a second format.
 *
 * Returns null when nothing usable was found — absent hours degrade to
 * UNKNOWN in the resolver, which is honest.
 */
export function parseVnOpenHours(
  raw: unknown,
): { osm: string; open24h: boolean } | null {
  if (!raw || typeof raw !== 'object') return null;
  const rangesByDay = new Map<string, string>();
  let saw24h = false;

  for (const [dayName, value] of Object.entries(raw as Record<string, unknown>)) {
    const norm = normalizeVnName(dayName);
    const osmDay = VN_DAY_TO_OSM[norm];
    if (!osmDay) continue;
    const items = Array.isArray(value) ? value : [value];
    const ranges: string[] = [];
    for (const item of items) {
      if (typeof item !== 'string') continue;
      const s = item.trim();
      if (!s) continue;
      if (/mo cua ca ngay|24\s*\/\s*24|24\s*gio/i.test(normalizeVnName(s))) {
        saw24h = true;
        continue;
      }
      if (/dong cua/i.test(normalizeVnName(s))) continue; // closed that day
      // "09:00–23:30" (en/em dash) → "09:00-23:30"
      const m = s.match(/(\d{1,2}[:.]\d{2})\s*[–—-]\s*(\d{1,2}[:.]\d{2})/);
      if (m) {
        const from = m[1].replace('.', ':').padStart(5, '0');
        const to = m[2].replace('.', ':').padStart(5, '0');
        if (from === '00:00' && to === '24:00') { saw24h = true; continue; }
        ranges.push(`${from}-${to}`);
      }
    }
    if (ranges.length > 0) rangesByDay.set(osmDay, ranges.join(','));
  }

  if (saw24h && rangesByDay.size === 0) return { osm: '24/7', open24h: true };
  if (rangesByDay.size === 0) return saw24h ? { osm: '24/7', open24h: true } : null;

  // Group consecutive OSM days sharing the same ranges → "Mo-Fr 07:00-22:00".
  const parts: string[] = [];
  const groups = new Map<string, string[]>();
  for (const day of OSM_DAY_ORDER) {
    const r = rangesByDay.get(day);
    if (!r) continue;
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(day);
  }
  for (const [range, days] of groups) {
    parts.push(`${days.length > 2 ? `${days[0]}-${days[days.length - 1]}` : days.join(',')} ${range}`);
  }
  return { osm: `${parts.join('; ')}${saw24h ? '; 24/7' : ''}`, open24h: saw24h };
}

// ── Price (scraped VND range → min/max + band) ─────────────────────────────

/**
 * `price_range` arrives dirty: "1-100.000 ₫", "100-200N ₫", "₫20,000-40,000".
 * Rules: strip currency marks; a bare number < 1000 reads as thousand-VND
 * (Vietnamese shorthand "100" = 100 nghìn, "N" = nghìn); dots inside a ≥3-digit
 * group are thousand separators. Band thresholds match VN café pricing.
 */
export function parseVnPriceRange(
  raw: unknown,
): { minVnd: number | null; maxVnd: number | null; band: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN' } | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const s = raw.replace(/₫|đ|vnd|vnđ/gi, '').replace(/\s/g, '');
  // Split on the range dash; keep each side's digits+dots.
  const parts = s.split(/[–—-]/).map((p) => p.trim()).filter((p) => /\d/.test(p));
  if (parts.length === 0) return null;

  const toVnd = (tok: string): number | null => {
    // "100.000" → 100000; "100" → 100000 (thousand shorthand); "200N" → 200000.
    const nMatch = tok.match(/^(\d+)n$/i);
    if (nMatch) return parseInt(nMatch[1], 10) * 1000;
    const cleaned = tok.replace(/[^\d.]/g, '');
    if (!cleaned) return null;
    if (cleaned.includes('.')) {
      const v = parseInt(cleaned.replace(/\./g, ''), 10);
      return Number.isFinite(v) ? v : null;
    }
    const v = parseInt(cleaned, 10);
    if (!Number.isFinite(v)) return null;
    return v < 1000 ? v * 1000 : v;
  };

  const values = parts.map(toVnd).filter((v): v is number => v !== null);
  if (values.length === 0) return null;
  const minVnd = Math.min(...values);
  const maxVnd = Math.max(...values);
  const band = maxVnd < 50_000 ? 'LOW' : maxVnd < 150_000 ? 'MEDIUM' : 'HIGH';
  return { minVnd, maxVnd, band };
}

// ── Amenities (scraped `about` sections → flat keys) ───────────────────────

/** about[].name → our amenity keys. Matched on normalized VN option names. */
// Keys are the real Google `about[].options[].name` strings after
// normalizeVnName — verified against the 7k-row HN scrape.
const ABOUT_OPTION_MAP: Record<string, string> = {
  'cho ngoi ngoai troi': 'outdoor_seating',
  'cho ngoi': 'seating',
  'bai do xe mien phi': 'parking',
  'do xe mien phi tren duong': 'parking',
  'bai do xe': 'parking',
  'cho phep mang theo cho': 'pets_allowed',
  'cho phep thu cung': 'pets_allowed',
  'wi-fi': 'wifi',
  'wi fi': 'wifi',
  'nha ve sinh': 'toilet',
  'an tai cho': 'dine_in',
  'phuc vu tai ban': 'table_service',
  'do an mang di': 'takeaway',
  'giao hang': 'delivery',
  'giao hang gian tiep': 'delivery',
  'nhan dat cho': 'reservations',
  'nhom': 'good_for_groups',
  'am cung': 'cozy',
  'thong thuong': 'casual',
  'lang tinh': 'quiet',
  'phu hop de lam viec tren may tinh xach tay': 'work_friendly',
  'lam viec': 'work_friendly',
  'phu hop cho tre em': 'family_friendly',
  'khong gian song ao': 'photo_friendly',
  'song ao': 'photo_friendly',
  'ro rang rai': 'spacious',
  'trang tri dep': 'nice_decor',
  'loi vao cho xe lan': 'wheelchair_accessible',
  'cho do xe cho xe lan': 'wheelchair_accessible',
  'cho ngoi cho xe lan': 'wheelchair_accessible',
  'ca phe ngon': 'good_coffee',
  'ca phe': 'serves_coffee',
  'nhieu tra ngon': 'good_tea',
  'bua trua': 'serves_lunch',
  'bua toi': 'serves_dinner',
  'ruou': 'serves_alcohol',
  'bia': 'serves_beer',
};

/**
 * `about` is `[{id, name, options: [{name, enabled}]}]` — Google's amenity
 * sections in Vietnamese. Flatten enabled options to normalized keys; the
 * decision VenueContext overlay maps these into its dims.
 */
export function aboutToAmenities(about: unknown): Record<string, boolean> | null {
  if (!Array.isArray(about)) return null;
  const out: Record<string, boolean> = {};
  for (const section of about) {
    if (!section || typeof section !== 'object') continue;
    const options = (section as { options?: unknown }).options;
    if (!Array.isArray(options)) continue;
    for (const opt of options) {
      if (!opt || typeof opt !== 'object') continue;
      const { name, enabled } = opt as { name?: unknown; enabled?: unknown };
      if (typeof name !== 'string' || enabled !== true) continue;
      const key = ABOUT_OPTION_MAP[normalizeVnName(name)];
      if (key) out[key] = true;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ── Categories (VN names → normalized primary) ─────────────────────────────

const CATEGORY_MAP: Record<string, string> = {
  'quan ca phe': 'cafe',
  'ca phe': 'cafe',
  'cafe': 'cafe',
  'tiem ca phe': 'cafe',
  'tra sua': 'tra_sua',
  'quan tra sua': 'tra_sua',
  'quan nuoc': 'quan_nuoc',
  'nha hang': 'restaurant',
  'quan an': 'restaurant',
  'nha hang sang': 'restaurant',
  'quan bia': 'beer_club',
  'bia hoi': 'beer_club',
  'beer club': 'beer_club',
  'bar': 'bar',
  'pub': 'bar',
  'tiem banh': 'bakery',
  'tiem banh mi': 'bakery',
  'lounge': 'lounge',
  'tra dao': 'tra_sua',
  'sinh to': 'juice_bar',
  'nuoc ep': 'juice_bar',
};

/** First matching normalized category wins; null when nothing maps. */
export function normalizeVnCategory(categories: unknown): string | null {
  if (!Array.isArray(categories)) return null;
  for (const cat of categories) {
    if (typeof cat !== 'string') continue;
    const mapped = CATEGORY_MAP[normalizeVnName(cat)];
    if (mapped) return mapped;
  }
  return null;
}

// ── Snapshot enrichment ────────────────────────────────────────────────────

/** Numeric VN phone normalization for the phone-match signal: digits only,
 * leading 0 → +84 equivalence handled by comparing suffixes. */
export function normalizePhone(phone: unknown): string | null {
  if (typeof phone !== 'string') return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 9) return null;
  return `+${digits.startsWith('84') ? digits : `84${digits.replace(/^0/, '')}`}`;
}
