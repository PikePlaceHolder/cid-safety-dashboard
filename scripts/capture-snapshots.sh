#!/usr/bin/env bash
# Grabs one still frame per camera in cameras.json, uploads it to R2, and
# records the row in D1 — run hourly (or daily) by
# .github/workflows/camera-snapshots.yml.
#
# SDOT cameras ("type": "sdot") are live HLS streams served off a Wowza
# server; ffmpeg pulls a single frame from the playlist. WSDOT cameras
# ("type": "wsdot") are still plain static JPGs, just downloaded directly.
#
# STREAM_HOST below is reverse-engineered from a third-party open-source
# Seattle camera viewer (github.com/the-sink/seattle-traffic-cams) rather
# than official SDOT docs — if captures start failing, that hostname is the
# first thing to re-check (SDOT's own camera list API is
# https://web.seattle.gov/Travelers/api/Map/Data?zoomId=18&type=2 if you
# need to re-derive it).

set -euo pipefail

STREAM_HOST="https://61e0c5d388c2e.streamlock.net:443/live"
R2_ENDPOINT="https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com"

TS_ISO=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
TS_SAFE=$(date -u +"%Y-%m-%dT%H-%M-%SZ")
OUTDIR="frames"
mkdir -p "$OUTDIR"

while IFS= read -r cam; do
  name=$(jq -r '.name' <<<"$cam")
  type=$(jq -r '.type' <<<"$cam")
  slug=$(jq -r '.slug' <<<"$cam")
  lat=$(jq -r '.lat' <<<"$cam")
  lon=$(jq -r '.lon' <<<"$cam")
  outfile="${OUTDIR}/${name}_${TS_SAFE}.jpg"

  if [ "$type" = "sdot" ]; then
    stream_url="${STREAM_HOST}/${slug}.stream/playlist.m3u8"
    echo "Grabbing frame from ${name} via HLS..."
    if ! ffmpeg -nostdin -y -loglevel error -timeout 15000000 -i "$stream_url" -frames:v 1 -q:v 3 "$outfile"; then
      echo "WARN: failed to grab ${name}, skipping"
      continue
    fi
  else
    img_url="https://images.wsdot.wa.gov/nw/${slug}"
    echo "Downloading still from ${name} (WSDOT)..."
    if ! curl -fsSL "$img_url" -o "$outfile"; then
      echo "WARN: failed to download ${name}, skipping"
      continue
    fi
  fi

  key="${name}/${TS_SAFE}.jpg"
  aws s3 cp "$outfile" "s3://${R2_BUCKET}/${key}" \
    --endpoint-url "$R2_ENDPOINT" --content-type "image/jpeg"

  payload=$(jq -n --arg name "$name" --argjson lat "$lat" --argjson lon "$lon" \
    --arg key "$key" --arg ts "$TS_ISO" \
    '{sql: "INSERT INTO camera_snapshots (camera_name, lat, lon, r2_key, captured_at) VALUES (?, ?, ?, ?, ?)",
      params: [$name, $lat, $lon, $key, $ts]}')

  curl -fsS -X POST \
    "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${CF_D1_DATABASE_ID}/query" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$payload" > /dev/null

  echo "Stored ${name} -> ${key}"
done < <(jq -c '.[]' cameras.json)
