# Deployment notes — thị trường Việt Nam

Cấu hình khuyến nghị để TREK Decision chạy tốt cho người dùng VN. Không có
secret nào trong file này — key chỉ đi qua env / secret store.

## Travel matrix (quyết định ETA)

| `DECISION_MATRIX_PROVIDER` | Dùng khi | Cần gì | Mode xe máy |
|---|---|---|---|
| `mock` (default) | dev/test | — | haversine × 1.3 |
| `vietmap` | production VN | `VIETMAP_API_KEY` | `cycling` ("Xe máy") → `motorcycle`; `driving` ("Ô tô") → `car` |
| `trackasia` | **production VN (khuyến nghị)** | `TRACKASIA_API_KEY` | `cycling` → `moto`; `driving` → `car`; `walking` ("Đi bộ") → `walk` |
| `google` | fallback khi có Google key | `GOOGLE_ROUTES_API_KEY` | `driving` → `TWO_WHEELER` |
| `osrm` | self-host / không trả phí | `OSRM_MATRIX_API_BASE` | profile `driving` (ô tô — xấp xỉ) |

TrackAsia được khuyến nghị cho VN: data bản địa, OSRM-shaped, billing theo
request (không nhân theo số cell như VietMap — rẻ hơn ~15x cho ma trận
nhóm), và là provider VN duy nhất có profile `walk` → chip "Đi bộ" nhận
ETA thật. `transit` vẫn trả cell `error` (UNKNOWN≠PASS, không fake số).
VietMap vẫn hỗ trợ như fallback; lưu ý VIETMAP chỉ có profile
`car|motorcycle|truck|container` — `walking`/`transit` sẽ nhận cell `error`.

```env
DECISION_MATRIX_PROVIDER=trackasia
TRACKASIA_API_KEY=<key từ account.track-asia.com>
# TRACKASIA_API_BASE=https://maps.track-asia.com   # chỉ đổi khi qua proxy/gateway
# DECISION_MATRIX_TIMEOUT_MS=10000

# Fallback:
# DECISION_MATRIX_PROVIDER=vietmap
# VIETMAP_API_KEY=<key từ vietmap.vn — loại "API key (search, route...)">
```

Key KHÔNG commit vào repo — đưa qua env của deployment hoặc secret store
(repo-scoped secret `VIETMAP_API_KEY` cho Devin sessions).

## Place search

`VietmapPlacesProvider` đã tích hợp (search/autocomplete/details/reverse qua
VIETMAP API v3). Bật bằng **Admin → Settings → Places provider → VietMap**
(`places_provider=vietmap`), hoặc để `auto` — chuỗi auto thử Google → Amap →
VietMap, dùng provider đầu tiên có key. Key đọc từ `VIETMAP_API_KEY` env
(không có ô nhập trong admin UI — khác Google/Amap vốn ghi vào cột users).

Cùng một key dùng cho cả matrix lẫn place search. Participant "Bạn xuất phát
từ đâu?" trên trang join cũng qua seam này (`/api/decision-participant/
origin-search`) — không còn nhập lat/lng tay.

Ưu tiên dự phòng: `places_provider=google` vẫn là phương án coverage tốt nhất
khi có Google key.

## Map tiles

- Default: **OpenFreeMap** (MapLibre, free, OSM vector tiles — đủ cho alpha,
  có `name:vi` ở vùng phủ OSM). Tránh public OSM raster tile server cho load
  production.
- Trả phí: Mapbox styles (cần `MAPBOX_ACCESS_TOKEN`).
- VietMap tiles: cần "Tilemap key" riêng + basemap style mới — future work nếu
  muốn label VN đầy đủ của VietMap.

## Hosting

- Self-host bằng Dockerfile hiện có; đặt server region gần VN (Singapore/HCM)
  để giảm latency matrix + tile.
- PWA/offline core của TREK đã sẵn — participant flow là online-only theo spec.

## Deploy Railway (all-in-one)

Một service duy nhất từ `Dockerfile` ở repo root — image đã bundle client +
server + WS, serve trên port từ biến `PORT` (Railway tự inject; Dockerfile
default 3000). Healthcheck sẵn: `GET /api/health`.

### Các bước trên dashboard

1. New Project → Deploy from GitHub repo → chọn repo này (Railway tự nhận
   Dockerfile).
2. Settings → Volumes → tạo **2 volumes**:
   - `/app/data` — SQLite (`travel.db`) + JWT/encryption keys + logs.
   - `/app/uploads` — ảnh upload, avatars, covers.
   KHÔNG mount volume ở `/app` — entrypoint sẽ fail (docs trong
   `server/scripts/entrypoint.sh`).
3. Variables — bảng dưới.
4. Settings → Networking → Generate Domain → copy domain vào `APP_URL` +
   `ALLOWED_ORIGINS` rồi redeploy.

### Variables

| Biến | Giá trị | Ghi chú |
|---|---|---|
| `APP_URL` | `https://<domain>.up.railway.app` | set sau khi generate domain |
| `ALLOWED_ORIGINS` | `https://<domain>.up.railway.app` | same-origin → có thể bỏ trống |
| `TRUST_PROXY` | `1` | cần khi chạy sau TLS proxy của Railway |
| `FORCE_HTTPS` | `true` | HTTPS redirect + secure cookies |
| `ADMIN_PASSWORD` | `<tự đặt>` | mật khẩu admin lần đầu |
| `DECISION_MATRIX_PROVIDER` | `trackasia` | ETA xe máy + đi bộ cho VN |
| `VIETMAP_API_KEY` | `<key từ vietmap.vn>` | gõ "API key (search, route...)" — dùng chung cho matrix + place search + geocode |
| `places_provider` | `vietmap` | admin setting (không phải env) — search/geocode qua VietMap |
| `PORT` | — | Railway inject, không set tay |

### Qua railway CLI

```bash
railway init           # link project mới
railway up             # build từ Dockerfile + deploy
railway volume add --mount-path /app/data
railway volume add --mount-path /app/uploads
railway domain         # sinh domain
```

Sau đó set biến trong bảng trên bằng `railway variables set KEY=value`.
Xác minh deploy: `curl https://<domain>/api/health` → `{"status":"ok"}`.
