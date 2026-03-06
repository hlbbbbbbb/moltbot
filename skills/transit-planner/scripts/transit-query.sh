#!/bin/bash
# 墨尔本公交查询 - 一键查路线
# 用法: transit-query.sh [起点] [终点]
# 支持别名: home, monash, city, chadstone

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
LOCATIONS_FILE="$SKILL_DIR/locations.json"

# Google Maps API Key
GOOGLE_MAPS_API_KEY="${GOOGLE_MAPS_API_KEY:-AIzaSyC-arzSpJMuESRa5pV6CmV3J0uJr_8Ht8Y}"

# === 地点别名解析 ===
resolve_location() {
    local input="$1"
    python3 -c "
import json, sys
input_str = sys.argv[1]
lower = input_str.lower()

alias_map = {
    '家': 'home', '我家': 'home', 'home': 'home', '住的地方': 'home',
    '学校': 'monash', 'monash': 'monash', 'clayton': 'monash', '莫纳什': 'monash',
    '市区': 'city', 'city': 'city', 'cbd': 'city', 'melbourne': 'city', 'flinders': 'city',
}
key = alias_map.get(lower, lower)

try:
    with open('$LOCATIONS_FILE') as f:
        locs = json.load(f)
    if key in locs:
        print(locs[key]['address'])
        sys.exit(0)
    for k, v in locs.items():
        if lower in [a.lower() for a in v.get('alias', [])]:
            print(v['address'])
            sys.exit(0)
except:
    pass
print(input_str)
" "$input"
}

# === 默认值 ===
ORIGIN_RAW="${1:-home}"
DEST_RAW="${2:-monash}"

ORIGIN=$(resolve_location "$ORIGIN_RAW")
DESTINATION=$(resolve_location "$DEST_RAW")

# === Google Maps Directions API ===
TMPFILE=$(mktemp)
trap "rm -f $TMPFILE" EXIT

ORIGIN_ENC=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$ORIGIN")
DEST_ENC=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$DESTINATION")

curl -s "https://maps.googleapis.com/maps/api/directions/json?origin=${ORIGIN_ENC}&destination=${DEST_ENC}&mode=transit&departure_time=now&alternatives=true&transit_mode=bus%7Ctrain%7Ctram&key=${GOOGLE_MAPS_API_KEY}" > "$TMPFILE"

# 解析并格式化输出
python3 - "$TMPFILE" "$ORIGIN_RAW" "$DEST_RAW" "$PTV_DEV_ID" "$PTV_API_KEY" << 'PYEOF'
import json, sys, os

tmpfile = sys.argv[1]
origin_raw = sys.argv[2]
dest_raw = sys.argv[3]
ptv_dev_id = sys.argv[4] if len(sys.argv) > 4 else ""
ptv_api_key = sys.argv[5] if len(sys.argv) > 5 else ""

with open(tmpfile) as f:
    data = json.load(f)

print(f"🚀 {origin_raw} → {dest_raw}")
print()

if data['status'] != 'OK':
    print(f"❌ Google Maps 查询失败: {data['status']}")
    print(data.get('error_message', ''))
    sys.exit(1)

routes = data.get('routes', [])
count = 0

for route in routes:
    leg = route['legs'][0]
    dep_time = leg.get('departure_time', {}).get('text', '?')
    arr_time = leg.get('arrival_time', {}).get('text', '?')
    duration = leg['duration']['text']
    
    steps_info = []
    has_transit = False
    
    for step in leg['steps']:
        if step['travel_mode'] == 'TRANSIT':
            has_transit = True
            td = step['transit_details']
            line = td['line']
            name = line.get('short_name', line.get('name', '?'))
            vehicle = line.get('vehicle', {}).get('type', '')
            dep_stop = td['departure_stop']['name']
            arr_stop = td['arrival_stop']['name']
            step_dep = td['departure_time']['text']
            step_arr = td['arrival_time']['text']
            num_stops = td.get('num_stops', '?')
            
            emoji = '🚌'
            if 'RAIL' in vehicle or 'TRAIN' in vehicle:
                emoji = '🚂'
            elif 'TRAM' in vehicle:
                emoji = '🚋'
            
            steps_info.append(f"   {emoji} {name}路: {dep_stop} → {arr_stop}")
            steps_info.append(f"      {step_dep} → {step_arr} ({num_stops}站)")
        elif step['travel_mode'] == 'WALKING':
            dur = step['duration']['text']
            dist = step['distance']['text']
            if int(step['duration']['value']) > 60:
                steps_info.append(f"   🚶 步行 {dur} ({dist})")
    
    if has_transit:
        count += 1
        print(f"方案{count}: {dep_time} 出发 → {arr_time} 到达 ({duration})")
        for s in steps_info:
            print(s)
        print()
        if count >= 5:
            break

if count == 0:
    print("⚠️ Google Maps 没返回公交方案")

# PTV section
if ptv_dev_id and ptv_api_key:
    print("━━━ PTV 实时 ━━━")
    # TODO: call PTV API
    print("(PTV 查询待实现)")
else:
    print("ℹ️ PTV 实时数据暂不可用（等 API Key）")
PYEOF
