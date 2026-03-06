#!/usr/bin/env python3
"""Query PTV API for transit information in Melbourne"""

import os
import sys
import json
import hashlib
import hmac
import urllib.request
import urllib.parse
from datetime import datetime, timezone

DEV_ID = os.environ.get('PTV_DEV_ID')
API_KEY = os.environ.get('PTV_API_KEY')
BASE_URL = "https://timetableapi.ptv.vic.gov.au"

ROUTE_TYPES = {
    0: "🚂 Train",
    1: "🚋 Tram", 
    2: "🚌 Bus",
    3: "🚐 V/Line",
    4: "🚢 Night Bus"
}

def sign_url(endpoint: str) -> str:
    """Generate HMAC-SHA1 signed URL for PTV API"""
    request = f"{endpoint}{'&' if '?' in endpoint else '?'}devid={DEV_ID}"
    signature = hmac.new(
        API_KEY.encode('utf-8'),
        request.encode('utf-8'),
        hashlib.sha1
    ).hexdigest().upper()
    return f"{BASE_URL}{request}&signature={signature}"

def api_request(endpoint: str) -> dict:
    """Make authenticated request to PTV API"""
    url = sign_url(endpoint)
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            return json.loads(response.read())
    except Exception as e:
        return {"error": str(e)}

def search_stops(query: str, route_types: list = None) -> list:
    """Search for stops by name"""
    if route_types is None:
        route_types = [0, 1, 2]  # Train, Tram, Bus
    
    types_param = ",".join(map(str, route_types))
    endpoint = f"/v3/search/{urllib.parse.quote(query)}?route_types={types_param}&include_outlets=false"
    data = api_request(endpoint)
    
    if "error" in data:
        return []
    
    return data.get('stops', [])

def get_departures(stop_id: int, route_type: int, max_results: int = 5) -> list:
    """Get next departures from a stop"""
    endpoint = f"/v3/departures/route_type/{route_type}/stop/{stop_id}?max_results={max_results}&expand=run&expand=route"
    data = api_request(endpoint)
    
    if "error" in data:
        return []
    
    departures = data.get('departures', [])
    routes = {r['route_id']: r for r in data.get('routes', [])}
    runs = {r['run_id']: r for r in data.get('runs', [])}
    
    # Enrich departures with route info
    for dep in departures:
        dep['_route'] = routes.get(dep.get('route_id'), {})
        dep['_run'] = runs.get(dep.get('run_id'), {})
    
    return departures

def format_time(iso_time: str) -> str:
    """Format ISO time to local time string"""
    if not iso_time:
        return "?"
    try:
        dt = datetime.fromisoformat(iso_time.replace('Z', '+00:00'))
        # Convert to Melbourne time (UTC+11 or UTC+10 depending on DST)
        # For simplicity, just show the time portion
        return dt.strftime('%H:%M')
    except:
        return "?"

def main():
    if not DEV_ID or not API_KEY:
        print("🚃 PTV 说：")
        print("  ⚠️ 未配置 (需要 PTV_DEV_ID 和 PTV_API_KEY)")
        print("  📝 申请地址: https://www.ptv.vic.gov.au/footer/data-and-reporting/datasets/ptv-timetable-api/")
        return 1
    
    origin = sys.argv[1] if len(sys.argv) > 1 else "Flinders Street Station"
    
    print("🚃 PTV 说：")
    
    # Search for origin stop
    stops = search_stops(origin)
    
    if not stops:
        print(f"  ⚠️ 找不到站点: {origin}")
        return 1
    
    # Get the first matching stop
    stop = stops[0]
    route_type = stop.get('route_type', 0)
    stop_id = stop.get('stop_id')
    stop_name = stop.get('stop_name', origin)
    
    print(f"  📍 {stop_name} ({ROUTE_TYPES.get(route_type, '公交')})")
    
    # Get departures
    departures = get_departures(stop_id, route_type)
    
    if not departures:
        print("  ⚠️ 暂无班次信息")
        return 0
    
    for dep in departures[:5]:
        scheduled = dep.get('scheduled_departure_utc')
        estimated = dep.get('estimated_departure_utc')
        
        sched_time = format_time(scheduled)
        
        # Determine status
        if estimated:
            est_time = format_time(estimated)
            if est_time == sched_time:
                status = "准点 ✓"
            else:
                status = f"实时 {est_time}"
        else:
            status = "计划"
        
        # Route info
        route = dep.get('_route', {})
        route_name = route.get('route_number') or route.get('route_name', '')
        
        # Destination
        run = dep.get('_run', {})
        destination = run.get('destination_name', '')
        
        if route_name and destination:
            print(f"  • {sched_time} - {route_name} → {destination} ({status})")
        elif destination:
            print(f"  • {sched_time} → {destination} ({status})")
        else:
            print(f"  • {sched_time} ({status})")
    
    return 0

if __name__ == "__main__":
    sys.exit(main())
