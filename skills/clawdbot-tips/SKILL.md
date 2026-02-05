---
name: clawdbot-tips
description: Collection of best practices and troubleshooting tips for Clawdbot operations. Includes guidance on opening URLs, sending media, and platform-specific formatting. Use when you encounter operational issues or need to perform common UI actions.
---

# Clawdbot Tips & Lessons

## UI & System Actions

### Opening Web Pages for the User
- **Avoid** `browser` tool for simply showing a page.
- **Prefer** direct shell command: `open -a "Google Chrome" "https://url"`

### Taking Screenshots
```bash
open -a "Google Chrome" "https://example.com"
# Wait a second for load
screencapture -x /tmp/screenshot.png
```

## Messaging Platforms

### Telegram Media
- To send an image, use `filePath` instead of `message` in the `message` tool.
- **Example**: `message(action="send", filePath="/tmp/desk.png", target="...")`

### Telegram Tables
- Markdown tables do **not** render.
- **Alternatives**:
  - Send a screenshot.
  - Use plain text with emojis for column separation.
  - Send information line-by-line.

### Feishu Formatting
- Feishu does not support Markdown (bold, headers, etc.).
- Use plain text only.
