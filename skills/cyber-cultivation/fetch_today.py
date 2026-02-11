import json
import datetime
import os
import random

# --- Paths ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
GANZHI_ANCHOR_PATH = os.path.join(DATA_DIR, "ganzhi_anchor.json")
SHISHEN_MAP_PATH = os.path.join(DATA_DIR, "shishen_map.json")
PATTERNS_PATH = os.path.join(DATA_DIR, "personal_patterns.json")

# --- Helpers ---
def load_json(path):
    with open(path, 'r') as f:
        return json.load(f)

def get_ganzhi(target_date_str):
    data = load_json(GANZHI_ANCHOR_PATH)
    anchors = data['anchors']
    # Use the closest anchor before target
    target_date = datetime.datetime.strptime(target_date_str, "%Y-%m-%d").date()
    
    selected_anchor = None
    for anchor in anchors:
        anchor_date = datetime.datetime.strptime(anchor['date'], "%Y-%m-%d").date()
        if anchor_date <= target_date:
            if selected_anchor is None or anchor_date > datetime.datetime.strptime(selected_anchor['date'], "%Y-%m-%d").date():
                selected_anchor = anchor
    
    if not selected_anchor:
        # Fallback to first if all are after (shouldn't happen with correct anchors)
        selected_anchor = anchors[0]

    anchor_date = datetime.datetime.strptime(selected_anchor['date'], "%Y-%m-%d").date()
    delta = (target_date - anchor_date).days
    
    current_gan_idx = (selected_anchor['gan_idx'] + delta) % 10
    current_zhi_idx = (selected_anchor['zhi_idx'] + delta) % 12
    
    gan = data['gan'][current_gan_idx]
    zhi = data['zhi'][current_zhi_idx]
    
    return gan, zhi, f"{gan}{zhi}"

def get_shishen(gan, zhi):
    shishen_map = load_json(SHISHEN_MAP_PATH)
    gan_shishen = shishen_map['map'].get(gan, "")
    zhi_shishen = shishen_map['map'].get(zhi, "")
    return f"{gan_shishen}/{zhi_shishen}"

# --- Main ---
today = datetime.date.today().strftime("%Y-%m-%d")
gan, zhi, ganzhi = get_ganzhi(today)
shishen = get_shishen(gan, zhi)

# Simulation for demo purposes since we don't have the full DB connection yet
# In a real scenario, this would fetch from Feishu/local logs
output = {
    "today": today,
    "ganzhi": f"{ganzhi}日",
    "shishen": shishen,
    "energy": None, # Not checked in yet
    "focus": None,
    "status": "未打卡"
}

print(json.dumps(output, ensure_ascii=False, indent=2))
