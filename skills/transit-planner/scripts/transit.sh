#!/bin/bash
# 墨尔本公交规划 - 同时查询 Google Maps 和 PTV

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

ORIGIN="${1:-Flinders Street Station, Melbourne}"
DESTINATION="${2:-Monash University Clayton}"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🚀 查询路线: $ORIGIN → $DESTINATION"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Query Google Maps
if [ -n "$GOOGLE_MAPS_API_KEY" ]; then
    bash "$SCRIPT_DIR/query_google.sh" "$ORIGIN" "$DESTINATION" 2>/dev/null || echo "🗺️ Google Maps: 查询失败"
else
    echo "🗺️ Google Maps 说："
    echo "  ⚠️ 未配置 (需要 GOOGLE_MAPS_API_KEY)"
fi

echo ""

# Query PTV
python3 "$SCRIPT_DIR/query_ptv.py" "$ORIGIN" "$DESTINATION" 2>/dev/null || echo "🚃 PTV: 查询失败"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
