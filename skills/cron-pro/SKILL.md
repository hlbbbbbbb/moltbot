---
name: cron-pro
description: Advanced rules and patterns for using the Clawdbot Cron tool. Covers proactive messaging, session targeting, and command formatting for reminders. Use when scheduling reminders, recurring tasks, or proactive follow-ups.
---

# Cron Pro Skill

## Proactive Messaging (Reminders)

**⚠️ Core Rule: Use `agentTurn` + `isolated` for proactive sends.**

Do **NOT** use `systemEvent` with `sessionTarget: main` for reminders; it will not reliably send a message to the user.

### Correct Pattern

```json
{
  "action": "add",
  "job": {
    "name": "Wake up Yihang",
    "schedule": { "kind": "at", "atMs": 1769732400000 },
    "sessionTarget": "isolated",
    "payload": {
      "kind": "agentTurn",
      "message": "提醒一航起床，现在早上8点了，语气轻松活泼，像朋友叫起床一样。",
      "deliver": true,
      "channel": "feishu"
    },
    "enabled": true
  }
}
```

## Channel Inheritance Rule

**在哪个渠道创建的 cron 任务，就在 payload 里显式指定该渠道的 `channel`。**

- 用户在飞书要求 → `"channel": "feishu"`
- 用户在 Telegram 要求 → `"channel": "telegram"`
- 用户在 Signal 要求 → `"channel": "signal"`
- 不要省略 channel，否则可能投递到错误渠道。

## Feishu Target Rule (Critical)

飞书 `agentTurn` 定时任务除了 `channel: "feishu"` 之外，**必须**带 `to`，否则会报：
`invalid receive_id (230001)`。

- 正确格式：`"to": "user:<ou_xxx>"`
- 这个 `<ou_xxx>` 用当前会话里的飞书发送者 id（sender id）
- 如果拿不到 `to`，不要创建任务，先向用户确认

示例：

```json
{
  "action": "add",
  "job": {
    "name": "Lunch Reminder",
    "schedule": { "kind": "at", "atMs": 1770870600000 },
    "sessionTarget": "isolated",
    "payload": {
      "kind": "agentTurn",
      "message": "提醒一航吃饭，语气自然。",
      "deliver": true,
      "channel": "feishu",
      "to": "user:ou_9a94582c9103468641131adcb415bd6b"
    },
    "enabled": true
  }
}
```

## Natural Language Style

The `message` field is a **task description** for the isolated agent, not a script to copy-paste.

- The isolated agent has its own persona (Lawrence). Let it understand the task and respond naturally.
- **Do NOT** use "请原样发送以下内容" — this makes the output robotic.
- **Do** describe the intent, context, and tone. Let the agent figure out the wording.

- **Good**: `"提醒一航起床，现在9:40了，语气轻松活泼。"`
- **Good**: `"给一航发个下午茶提醒，顺便问问他中午吃了啥。"`
- **Bad**: `"请原样发送以下内容，不要添加任何其他话：一航起床啦！"`

## Proactive Care (主动关怀)

The LLM is authorized to **create cron jobs on its own initiative** when it senses the user needs follow-up care. No user request needed.

**Examples:**
- User feels sad → schedule a check-in 1-2 hours later
- User is doing something important → follow up afterward
- Late night chat → gentle nudge to sleep
- User is sick → remind to take meds / drink water later

**Rules:**
- Don't tell the user you're scheduling it (breaks the magic)
- Be restrained — max 1-2 follow-ups per topic
- Respect quiet hours (23:00-08:00) unless user is clearly awake
- Always include context in the message so the isolated agent knows why

## Scheduling Types

- `at`: One-shot. Requires `atMs` (Unix ms timestamp).
- `every`: Recurring interval. Requires `everyMs`.
- `cron`: Complex schedules. Requires `expr` (standard cron expression).
