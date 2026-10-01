# Venue Data Spec — Nguồn dữ liệu quán cafe cho Decision Engine

**Status:** Draft proposal
**Phạm vi:** xây dựng corpus venue (café / đồ uống / ăn nhẹ) tại Việt Nam, phục vụ `Chốt quán` resolver + VenueContext
**Ngữ cảnh:** `docs/decision/PRODUCT_SPEC.md` §11–§14, `IMPLEMENTATION_PLAN.md` Phase 17

---

## 1. Mục tiêu

Resolver cần trả lời, cho một candidate venue:

| Câu hỏi resolver | Field cần |
|---|---|
| Mở cửa lúc giờ hẹn không? (hard constraint) | `opening_periods`, `opening_weekdays`, `opening_special_days`, `open_now` |
| Vượt budget không? | `price_band` / `price_level` / `price_range` |
| Đủ tin cậy để gợi ý? | `rating`, `rating_count`, `business_status` |
| Hợp dịp/vibe? | `VenueContext` dims: `noise_level`, `seating_style`, `laptop_friendliness`, `group_friendliness`, `date_friendliness`, `photo_friendliness`, `drink_tags`, `vibe_tags`, `occasion_tags` |
| Giải thích được không? | `description`, `facts`, `google_maps_url`, `image_url` |
| Định danh ổn định? | `venue_key` (`google:` → `amap:` → `osm:`/`gers:` → `vietmap:` → `coords:`) |

Bộ field chuẩn đích = `decisionCandidateSnapshotSchema` + `decisionCandidateFactsSchema` (`shared/src/decision/decision.schema.ts`). Hôm nay VietMap trả gần hết các field này là `null` (`vietmap.provider.ts` — không có rating/hours/facts), Overture/OSM có hours/website/phone nhưng không có rating. **Google Places là nguồn duy nhất có đủ rating + giờ mở cửa + attributes + ảnh + review ở VN.**

---

## 2. Ràng buộc pháp lý — đọc trước khi chọn chiến lược

Đây là phần quyết định kiến trúc, không phải phần phụ:

1. **Cào trực tiếp `google.com/maps` (browser automation, HTTP scraping) vi phạm Google ToS** và là vector bị chặn IP/kiện. Không đi đường này trong codebase — tối đa là PoC ngoài repo.
2. **Places API (New) là đường hợp lệ duy nhất lấy data Google**, nhưng ToS giới hạn:
   - `place_id` được lưu vĩnh viễn; **mọi field khác chỉ được cache ≤ 30 ngày** rồi phải refresh hoặc xoá.
   - Không được dùng Google content để **xây một database/đối thủ cạnh tranh** → corpus "sở hữu" của mình không thể bản sao của Google data.
   - `codebase đã ghi nhận bài học này`: `trek-places.client.ts` — *"paying Google for a text search whose terms then forbid storing what comes back"*.
3. **Vendor scrape-hộ** (Outscraper, Apify Google Maps Scraper, SerpAPI `google_maps`, Bright Data): rẻ hơn API chính thức, trả đủ rating/hours/photos/reviews, nhưng vẫn là Google-derived data → cùng vấn đề "build database từ Google content". Chấp nhận được như **one-shot bootstrap / benchmarking / gap-filling**, không nên là nguồn nền.

**Kết luận kiến trúc (3 lớp, mỗi lớp một thời hạn sống khác nhau):**

```text
Lớp 1 — OWNED CORPUS (lưu vĩnh viễn, là "sự thật" của mình)
  Overture/TREK Places + OpenStreetMap + VietMap + dữ liệu tự sinh
  (DecisionGraph, host/participant edits, merchant-submitted sau này)
Lớp 2 — GOOGLE FRESHNESS LAYER (cache ≤30 ngày, refresh được, xoá được)
  Places API (New): rating, hours, attributes, photos, reviews(5)
  giữ vĩnh viễn chỉ google_place_id + ghép vào venue_key
Lớp 3 — DERIVED OVERLAY (lưu vĩnh viễn vì là suy luận của mình)
  VenueContext dims + confidence + evidence_json
  suy ra từ types/attributes/review-text đã qua xử lý (không lưu raw review)
```

Điểm mấu chốt: **giá trị lâu dài nằm ở lớp 1 + 3**, Google chỉ là lớp "tươi". Điều này cũng đúng tinh thần spec §17 (DecisionGraph là moat, không phải generic ratings).

---

## 3. Data model

### 3.1 Bảng corpus (mới, offline-seed được)

```sql
decision_venues (
  venue_key        TEXT PRIMARY KEY,     -- per §11: google:... / osm:... / vietmap:... / coords:...
  name             TEXT NOT NULL,
  name_norm        TEXT NOT NULL,        -- lowercase, strip diacritics
  lat              REAL, lng             REAL,
  address          TEXT,
  locality         TEXT,                 -- phường/quận/tỉnh → phục vụ coverage stats
  category         TEXT,                 -- normalized: 'cafe' | 'coffee_shop' | 'tea' | 'bakery' | ...
  price_band       TEXT,                 -- '$'..'$$$$' hoặc VND band, chuẩn hoá 1 chiều
  facts_json       TEXT,                 -- decisionCandidateFactsSchema + parking/reservable/wifi
  base_json        TEXT,                 -- owned-layer merge: OSM/Overture/VietMap fields
  source_mask      INTEGER,              -- bitmask nguồn đã thấy venue này
  first_seen_at    TEXT, last_seen_at    TEXT,
  status           TEXT DEFAULT 'active' -- 'active' | 'closed_suspect' | 'closed'
);

google_venue_freshness (                -- Lớp 2, TTL-enforced
  venue_key        TEXT PRIMARY KEY REFERENCES decision_venues(venue_key),
  google_place_id  TEXT NOT NULL,       -- storable vĩnh viễn
  snapshot_json    TEXT NOT NULL,       -- decisionCandidateSnapshotSchema
  reviews_json     TEXT,                -- tối đa 5 review text, CHỈ để mine rồi xoá/refresh
  retrieved_at     TEXT NOT NULL,       -- mọi row >30 ngày = stale, job xoá/refresh
  expires_at       TEXT NOT NULL
);

-- VenueContext (spec §12) đã có: decision_venue_contexts — mở rộng sang
-- venue-scoped (venue_key) thay vì candidate-scoped khi corpus đi vào runtime.
```

`decision_candidates.snapshot_json` giữ nguyên vai trò freeze-evidence — corpus chỉ *feed* snapshot, không thay thế.

### 3.2 Field mapping: Places API (New) → contract

| Google field (New) | Đích |
|---|---|
| `id` | `google_place_id`, `venue_key` (`google:<id>`) |
| `displayName`, `location`, `formattedAddress`/`shortFormattedAddress`, `primaryType`, `types` | `name`, `lat/lng`, `address`, `category` (map về taxonomy nội bộ như `POI_CATEGORY_TO_TREK`) |
| `rating`, `userRatingCount` | `rating`, `rating_count` |
| `priceLevel` (0–4), `priceRange` | `price` + `price_band` (map sang VND band cho VN) |
| `regularOpeningHours` (`weekdayDescriptions`, `periods`, `specialDays`), `currentOpeningHours.openNow` | `opening_weekdays`, `opening_periods`, `opening_special_days`, `open_now` |
| `websiteUri`, `nationalPhoneNumber`/`internationalPhoneNumber`, `googleMapsUri` | `website`, `phone`, `google_maps_url` |
| `outdoorSeating`, `takeout`, `delivery`, `servesVegetarianFood`, `reservable`, `menuUri` | `facts.*` (`outdoor_seating`, `takeaway`, `delivery`, `vegetarian`, `menu_url`, +`reservable`) |
| `accessibilityOptions.wheelchairAccessible*` | `facts.wheelchair` |
| `parkingOptions.*`, `paymentOptions.*`, `goodForGroups`, `goodForChildren`, `liveMusic`, `servesCoffee`, `servesDessert`, `restroom` | `facts` mở rộng + input cho VenueContext dims |
| `photos[].name/widthPx/heightPx/authorAttributions` | photo refs → `place-photos` cache (media endpoint) → `image_url` |
| `editorialSummary`, `generativeSummary`, `reviews[].text` (≤5) | mining input → `vibe_tags`, `noise_level`, `description` fallback — **không lưu raw** lâu hơn 30d |
| `businessStatus` | `status` (`CLOSED_*` → closed_suspect) |
| `utcOffsetMinutes` | múi giờ khi eval "mở lúc X" |

### 3.3 Taxonomy nội bộ (canonical `category`)

Chuẩn hoá mọi nguồn về một set nhỏ, map một lần như `POI_CATEGORY_TO_TREK` đang làm:
`cafe`, `coffee_shop`/`cà phê`, `tea`/`trà sữa`, `bakery`, `juice`, `dessert`, `roastery`, `bar`(loại trừ hoặc giữ riêng). Quán ăn chính loại khỏi corpus V1 — đúng scope "café / drink venues".

---

## 4. Pipeline thu thập

```text
coverage plan → discover → harvest → normalize → resolve identity → store → refresh
```

### 4.1 Coverage plan (script, không phải runtime module)

- Input: danh sách polygon quận/huyện VN (OSM admin boundaries, qua Nominatim/Overpass hoặc dump sẵn).
- Chia polygon thành lưới **H3 res ~9–10** (≈0.1–0.3 km²/cell urban) hoặc tile vuông 1 km.
- Ước lượng: ~63 quận/huyện trung tâm × vài trăm cell → hàng chục nghìn cell. Cell là đơn vị resume: bảng `harvest_cells(cell_id, done_at, result_count, truncated)` cho chạy-dở.

### 4.2 Discover (2 đường, chạy song song, union kết quả)

1. **Nearby Search (New)** per cell: `includedTypes: ['cafe','coffee_shop','bakery','tea_house','juice_shop','dessert_shop']`, `maxResultCount: 20`. **Nếu response = 20 (sát cap) → chia cell 4 → chạy lại** (adaptive subdivision — trung tâm Q1/Q3 HCM sẽ sát cap).
2. **Text Search (New)** per cell, query variants để bắt quán không gắn type chuẩn: `"cà phê"`, `"coffee"`, `"trà sữa"`, `"cafe làm việc"`, `"quán nước"` + `locationBias` circle cell, paginate 3 trang ×20.
3. **Bổ sung miễn phí, chạy trước**: `trek-places` `/v1/bbox` (Overture, cap 1.5°×1.5°, 20k rows) + Overpass `amenity=cafe` per quận + VietMap `search/v3` — điền corpus lớp 1 mà không tốn bill Google; Google chỉ trả cho phần enrich.

Output của stage: `(google_place_id | osm_id | gers | vietmap_ref_id)` × source → dedup theo §4.4.

### 4.3 Harvest (Google, có bill → field mask chặt)

- `Place Details` per `place_id`, field mask một lần chọn theo bảng §3.2 (tránh Enterprise-tier fields nếu không cần — `reviews`+`generativeSummary` đẩy call lên tier đắt nhất; cân nhắc 2-tier: Details rẻ cho toàn bộ, tier đầy đủ chỉ cho venue "active đủ điểm" hoặc theo demand).
- Photos: `photos[].name` → Photo Media, đẩy qua `PlacePhotoCacheService`/storage driver — reuse, không viết downloader mới.
- Rate-limit: exponential backoff + daily budget cap + tôn trọng 429; mọi call ghi metering row (`provider, sku_tier, cost_unit`) giống `route-usage` đang làm cho matrix.

### 4.4 Resolve identity → `venue_key`

Thứ tự §11 + mở rộng `place-match.ts`:

1. `google_place_id` trùng → cùng venue.
2. `osm_id`/`gers:`/`vietmap:` trùng → cùng venue.
3. Cross-provider match: `|Δlat|/|Δlng|` trong ~30 m **và** `name_norm` tương đồng (diacritics-folded Levenshtein ≤ ngưỡng, hoặc token-overlap ≥ 0.8 — tên quán VN hay lệch dấu/hoa thường; tuyệt đối không merge theo toạ độ khi tên khác hẳn — bẫy `place-match.ts` đã ghi: quán khác nhau cùng địa chỉ là phổ biến).
4. Không match → `coords:<lat5>:<lng5>:<name_norm>`.

Một venue_key gom nhiều provider id trong `base_json`/`source_mask` → freshness layer join được vào bất kỳ candidate nào sau này.

### 4.5 Normalize & store

- Mỗi record qua `toPlaceRecord`-style normalizer → `decisionCandidateSnapshotSchema` parse (fail-closed: record hỏng → quarantine bucket, không throw cả batch).
- Chuẩn hoá `category` theo §3.3, `price_band` theo bảng VND-band (`<30k`, `30–60k`, `60–100k`, `>100k` — calibrate theo priceRange VND thực tế).
- Corpus xuất ra **NDJSON/Parquet + SQLite** (artifact offline) và **ingest command** ghi vào bảng `decision_venues` của instance. Giữ `raw_json` của Google chỉ trong lớp freshness TTL.

### 4.6 Refresh & lifecycle

- `hours`/`open_now`/`businessStatus`: TTL 7 ngày (đã có precedent: `CACHE_TTL_MS` enrichment); `rating`/`rating_count`/`price`: 30 ngày (trần ToS — lên lịch refresh đúng hạn thay vì để expire).
- Refresh theo demand: venue đang là candidate trong session `COLLECTING/RESOLVING` → fresh-first luôn lúc add candidate (evidence path hiện tại); corpus nền refresh theo job qua `CronRegistrarService`, ưu tiên locality có traffic.
- `businessStatus ∈ {CLOSED_TEMPORARILY, CLOSED_PERMANENTLY}` → `status` chuyển trạng thái, resolver hard-fail quán đóng (UNKNOWN≠PASS — spec §14).
- Job nightly: xoá `snapshot_json`/`reviews_json` đã quá `expires_at` — compliance là code path, không phải lời hứa.

---

## 5. VenueContext derivation (lớp 3)

Google không trả `noise_level` hay `laptop_friendliness`. Suy ra từng dim từ:

```text
noise_level        ← types(cafe quán yên?) + review keywords ('ồn','yên tĩnh','nhạc lớn')
seating_style      ← outdoorSeating + review ('lệ giường','sofa','bàn cao')
laptop_friendliness ← review ('làm việc','wifi','ổ cắm','laptop') + wifi fact
group_friendliness ← goodForGroups + seating + review ('nhóm','đông')
date_friendliness  ← review ('hẹn hò','lãng mạn') + vibe ('view','rooftop')
photo_friendliness ← photo count + review ('sống ảo','check-in','view đẹp')
price_band         ← priceLevel/priceRange → VND band §4.5
parking            ← parkingOptions + review ('chỗ để xe','gửi xe')
drink_tags         ← types + menu + review ('cà phê muối','cold brew','trà trái cây')
```

Mỗi dim ghi `confidence` (keyword hits / sample size) + `evidence_json` trỏ nguồn — đúng §12 *"explicit evidence / confidence where practical"*. V1 dùng rule-based keyword miner trên `reviews[].text`+`editorialSummary` (deterministic, test được); LLM pass chỉ khi cần và gắn `model_version` vào evidence.

---

## 6. Chi phí & kế hoạch bill (ước lượng — verify pricing trước khi chạy)

Đơn giá Places API (New) thay đổi theo thời gian → script đọc bảng SKU từ config, không hard-code. Khung ước lượng cho ~N venue:

```text
discover  ≈ cells × (1–4 Nearby calls)              — rẻ, theo số cell
details   ≈ N × [Essentials|Pro|Enterprise]          — đắt nhất, theo N
photos    ≈ k × N × media                            — theo số ảnh cache
refresh   ≈ N_active × freq/30d
```

Order-of-magnitude mục tiêu: **bootstrap ~30–60k café VN** (HCM+HN+ĐN+HP+Cần Thơ+Hải Phòng+đô thị du lịch), Google-side chủ yếu nằm ở Details+photos. Với N=50k, k=3 ảnh → ballpark ~vài trăm USD một vòng đầy đủ ở tier Pro; giảm ~70% nếu chỉ Details đầy đủ cho venue "đã từng vào candidate set" còn corpus nền chỉ lưu Essentials (name/coords/hours/rating mà không reviews/photos).

Chiến lược chi tiền theo giá trị:
1. **Corpus nền = miễn phí** (Overture bbox + OSM + VietMap) — luôn đầy đủ name/coords/category.
2. **Google harvest 2 vòng**: vòng A Essentials-tier toàn corpus; vòng B Pro/Enterprise-tier **chỉ cho locality đang mở session** hoặc venue trở thành candidate (lazy enrich, reuse đúng enrichment path hiện có — candidate pin đã nhận `evidence` blob).
3. Đối chứng vendor scrape (Outscraper/Apify): ~vài USD/1k venue full-detail+reviews — hữu ích cho **bootstrap một lần** hoặc đối chứng coverage, nhưng xếp vào vùng "không phải nguồn nền" theo §2.
4. Budget guardrail: config `VENUE_HARVEST_DAILY_CAP_USD`, metering per-call, dừng sạch khi chạm cap.

---

## 7. Chất lượng & đánh giá

- **Coverage**: `venue/cell density` so Overture+OSM count cùng cell — cell Google < 50% baseline → flag under-harvested (subdivide thêm). Check `businessStatus` để loại quán đóng khỏi số liệu.
- **Fill rate** per field: % venue có `hours`, `rating`, `price_band`, mỗi `facts.*` — dashboard admin + báo cáo theo locality.
- **Dedup dup-rate**: sample audit 200 venue kiểm tay (nhân viên/product), mục tiêu dup < 2%.
- **Freshness SLO**: % candidate snapshot có `retrieved_at < 30d`; % corpus có hours < 7d.
- **Search quality**: `place_shadow` corpus đã sẵn có là evaluator — hỏi "local corpus đứng top-5 bao nhiêu lần so provider sống" (đúng mục đích bảng này được thiết kế).

---

## 8. Kế hoạch triển khai (mapping vào repo)

```text
scripts/venue-harvest/          # offline tool — KHÔNG phải Nest module
  coverage.ts   discover.ts     harvest.ts
  normalize.ts  resolve.ts      export.ts (NDJSON + SQLite)
server/src/nest/venues/         # runtime mỏng: corpus read + freshness
  venues.module.ts / venues.service.ts / venues.repository.ts
  venue-refresh.job.ts          # qua CronRegistrarService
  venues.admin.controller.ts    # coverage/fill/dup metrics
shared/src/venue/venue.schema.ts # corpus row + freshness row contracts
migrations                      # decision_venues, google_venue_freshness, harvest_cells
```

Nguyên tắc: harvest tool **script-first** (corpus là artifact, không phải feature runtime) → ingest qua migration/seed → runtime chỉ đọc + refresh. Search path sau đó merge corpus vào candidates: `/api/maps/search` trả local-corpus hit kèm evidence blob → `addCandidate` đã sẵn nhận `DecisionCandidateEvidence` (không cần đổi contract candidate).

Milestones:

| Phase | Deliverable | Gate |
|---|---|---|
| D-0 | Corpus miễn phí (Overture bbox + OSM + VietMap) cho 1 quận pilot (Q1/Q3 HCM) | `decision_venues` seeded, ≥80% quán có coords+name |
| D-1 | Google discover+harvest cho pilot, 2-tier field mask | fill rate rating ≥90%, hours ≥70%; metering works |
| D-2 | Identity resolution + corpus export/ingest | dup <2% audit, venue_key stable |
| D-3 | VenueContext miner (rule-based) | dims có confidence, evidence_json, unit tests |
| D-4 | Freshness jobs + 30d purge + candidate-search merge | TTL enforcement test, resolver nhận snapshot từ corpus |
| D-5 | Scale ra VN-wide theo demand | coverage report per locality |

## 9. Rủi ro & câu hỏi mở

- **ToS 30-day cache** là hard constraint — nếu product cần hiển thị rating/hours "luôn có", chỉ có cách hợp lệ là refresh trước hạn (đã thiết kế) hoặc tự sinh data (DecisionGraph + merchant claims). Không lách bằng "lưu bản chuẩn hoá" — normalization không reset TTL.
- Review count API = tối đa 5 → `vibe` mining thiếu mẫu ở quán ít review; chấp nhận `confidence` thấp + UNKNOWN ≠ PASS.
- Photos: chỉ proxy qua photo-cache với attribution (bắt buộc theo license/Google policy) — không lưu binary vĩnh viễn ngoài chính sách.
- Open: phạm vi địa lý launch (HCM-first hay top-6 đô thị?), ngân sách vòng B, có cần `delivery`-platform signals (Grab/ShopeeFood) như lớp fresh riêng sau này.
