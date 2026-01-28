---
name: music-control
description: Control macOS music players (QQ Music, Netease Music, Apple Music) to search, play, pause, skip, and adjust volume. Use when the user wants to listen to a specific song, artist, or control playback. Supports UI automation via Peekaboo and AppleScript for background control.
---

# Music Control

This skill allows you to control music applications on macOS.

## Supported Apps
- **QQ Music** (Preferred for Chinese songs)
- **Netease Music** (NetEase Cloud Music)
- **Apple Music**

## Workflows

### 1. Play a Specific Song
When a user asks to play a song:
1. Identify the target app (default to QQ Music or Netease if not specified).
2. Set volume if requested using AppleScript: `osascript -e 'set volume output volume <level>'`.
3. Use the `scripts/play_song.py` script provided in this skill to search and play.

### 2. Basic Playback Control
Use AppleScript for fast, non-intrusive control:
- **Pause/Play**: `osascript -e 'tell application "<AppName>" to playpause'`
- **Next**: `osascript -e 'tell application "<AppName>" to next track'`
- **Previous**: `osascript -e 'tell application "<AppName>" to previous track'`

### 3. UI Automation (Peekaboo)
If AppleScript fails or the app is in a state where it won't respond to standard commands:
1. Use `peekaboo window focus --app "<AppName>"` to bring the app to front.
2. Use `peekaboo menu click --app "<AppName>" --path "播放控制 > 播放"` (or similar path depending on the app).

## Scripts

### `scripts/play_song.py`
A robust script to search and play songs using a combination of AppleScript (for typing/shortcuts) and clipboard-pasting (to avoid IME issues).

**Usage**:
```bash
python3 scripts/play_song.py --app "QQMusic" --song "江湖之间"
```
