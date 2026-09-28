#!/usr/bin/env bash
# Fetch Vietnam drink venues from Overture Maps (CDLA-Permissive-2.0) into an
# NDJSON file ready for ingest-venues-jsonl.ts --source gers.
#
#   scripts/fetch-overture-vn.sh [workdir]
#
# Uses the official `overturemaps` Python CLI in an isolated venv (public S3
# bucket, no credentials). VN bbox: mainland 102.0–109.7E / 8.3–23.5N.
set -euo pipefail

WORK=${1:-/tmp/overture}
GEOJSON="$WORK/places-vn.geojson"
OUT="$WORK/venues-vn.jsonl"
VENV="$WORK/.venv"

mkdir -p "$WORK"
if [ ! -x "$VENV/bin/overturemaps" ]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet 'overturemaps>=0.13'
fi

echo "[1/2] downloading places in VN bbox (latest release)…"
# --no-stac: the STAC catalog lags fresh releases (verified 2026-09-23.1);
# reading the dataset directly just works.
"$VENV/bin/overturemaps" download \
  --bbox=102.0,8.3,109.7,23.5 \
  --type=place -f geojsonseq -o "$GEOJSON" --no-stac

echo "[2/2] filtering to drink venues…"
node "$(dirname "$0")/overture-to-jsonl.mjs" "$GEOJSON" > "$OUT"

echo "done → $OUT"
echo "ingest with: TREK_DB_FILE=<db> npx tsx scripts/ingest-venues-jsonl.ts $OUT --source gers"
