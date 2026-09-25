# Deployment notes — thị trường Việt Nam

Cấu hình khuyến nghị để TREK Decision chạy tốt cho người dùng VN. Không có
secret nào trong file này — key chỉ đi qua env / secret store.

## Travel matrix (quyết định ETA)

| `DECISION_MATRIX_PROVIDER` | Dùng khi | Cần gì | Mode xe máy |
|---|---|---|---|
| `mock` (default) | dev/test | — | haversine × 1.3 |
| `vietmap` | **production VN** | `VIETMAP_API_KEY` | `driving` → `motorcycle` (native) |
| `google` | fallback khi có Google key | `GOOGLE_ROUTES_API_KEY` | `driving` → `TWO_WHEELER` |
| `osrm` | self-host / không trả phí | `OSRM_MATRIX_API_BASE` | profile `driving` (ô tô — xấp xỉ) |

VietMap được chọn cho VN: data bản địa, profile `motorcycle` thật (xe máy là
phương tiện chính), rẻ hơn Google. Lưu ý: VIETMAP chỉ có profile
`car|motorcycle|truck|container` — participant chọn `walking`/`cycling`/`transit`
sẽ nhận cell `error` (resolver đọc UNKNOWN≠PASS, không fake số).

```env
DECISION_MATRIX_PROVIDER=vietmap
VIETMAP_API_KEY=<key từ vietmap.vn — loại "API key (search, route...)">
# VIETMAP_API_BASE=https://maps.vietmap.vn   # chỉ đổi khi qua proxy/gateway
# DECISION_MATRIX_TIMEOUT_MS=10000
```

Key KHÔNG commit vào repo — đưa qua env của deployment hoặc secret store
(repo-scoped secret `VIETMAP_API_KEY` cho Devin sessions).

## Place search

Hiện tại: TREK Places + Nominatim (OSM) — chạy ngay không cần key; coverage
VN ở mức alpha. Nâng cấp theo thứ tự ưu tiên:

1. `places_provider=google` trong admin settings (key đã có sẵn integration) —
   coverage VN tốt nhất ngay bây giờ.
2. VietMap search adapter cho `/api/maps/*` — seam mới theo pattern
   `providers/amap.provider.ts`, chưa implement (future work nếu muốn full
   VietMap stack).

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
