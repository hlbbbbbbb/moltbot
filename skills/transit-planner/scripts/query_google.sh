#!/bin/bash
# Query Google Maps Directions API for transit routes

set -e

ORIGIN="${1:-Flinders Street Station, Melbourne}"
DESTINATION="${2:-Monash University Clayton}"

if [ -z "$GOOGLE_MAPS_API_KEY" ]; then
    echo "⚠️ GOOGLE_MAPS_API_KEY 未设置"
    exit 1
fi

# URL encode the parameters
encode() {
    echo "$1" | sed 's/ /+/g' | sed 's/,/%2C/g'
}

ORIGIN_ENC=$(encode "$ORIGIN")
DEST_ENC=$(encode "$DESTINATION")

# Query the API
RESPONSE=$(curl -s "https://maps.googleapis.com/maps/api/directions/json?\
origin=${ORIGIN_ENC}\
&destination=${DEST_ENC}\
&mode=transit\
&departure_time=now\
&alternatives=true\
&key=${GOOGLE_MAPS_API_KEY}")

# Check for errors
STATUS=$(echo "$RESPONSE" | jq -r '.status')
if [ "$STATUS" != "OK" ]; then
    echo "❌ Google Maps API 错误: $STATUS"
    echo "$RESPONSE" | jq -r '.error_message // empty'
    exit 1
fi

# Parse and display routes
echo "🗺️ Google Maps 说："
echo "$RESPONSE" | jq -r '
  .routes[:3][] | 
  "  • \(.legs[0].departure_time.text) 出发 → \(.legs[0].arrival_time.text) 到达 (\(.legs[0].duration.text))\n    路线: \([.legs[0].steps[] | select(.travel_mode == "TRANSIT") | .transit_details.line.short_name // .transit_details.line.name] | join(" → "))"
'
