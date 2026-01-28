import subprocess
import argparse
import sys
import time
import json

def run_command(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True)

def play_song(app_name, song_name):
    app_map = {
        "qq": "QQMusic",
        "qqmusic": "QQMusic",
        "netease": "NeteaseMusic",
        "music": "Music"
    }
    
    target_app = app_map.get(app_name.lower(), app_name)
    
    # 1. 拷贝歌名到剪贴板
    subprocess.run(f'echo "{song_name}" | pbcopy', shell=True)
    
    # 2. 激活并搜索
    search_script = f'''
    tell application "{target_app}" to activate
    delay 0.5
    tell application "System Events"
        tell process "{target_app}"
            keystroke "f" using {{command down}}
            delay 0.3
            keystroke "a" using {{command down}}
            key code 51
            delay 0.2
            keystroke "v" using {{command down}}
            delay 0.5
            key code 36 -- 回车搜索
        end tell
    end tell
    '''
    run_command(f"osascript -e '{search_script}'")
    time.sleep(2) # 等待搜索结果加载
    
    # 3. 使用 Peekaboo 点击第一个搜索结果
    # 我们先看看能不能找到包含歌名的元素
    see_cmd = f'peekaboo see --app "{target_app}" --json'
    res = run_command(see_cmd)
    
    if res.returncode == 0:
        try:
            data = json.loads(res.stdout)
            elements = data.get("data", {}).get("ui_elements", [])
            
            # 寻找搜索结果中的第一首歌
            # 逻辑：寻找 label 或 description 中包含歌名的 actionable 元素
            target_id = None
            for elem in elements:
                # 排除搜索框本身（通常 role 是 textField）
                if elem.get("role") != "textField" and elem.get("is_actionable"):
                    label = elem.get("label", "")
                    desc = elem.get("description", "")
                    if song_name in label or song_name in desc:
                        target_id = elem["id"]
                        break
            
            if target_id:
                click_cmd = f'peekaboo click --on {target_id} --app "{target_app}"'
                run_command(click_cmd)
                return True
        except Exception as e:
            print(f"Peekaboo logic failed: {e}")

    # Fallback: 实在不行就再按两下回车，或者双击坐标（如果已知）
    fallback_script = f'''
    tell application "System Events"
        tell process "{target_app}"
            delay 0.5
            key code 36
            delay 0.5
            key code 36
        end tell
    end tell
    '''
    run_command(f"osascript -e '{fallback_script}'")
    return True

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", required=True)
    parser.add_argument("--song", required=True)
    args = parser.parse_args()
    play_song(args.app, args.song)
