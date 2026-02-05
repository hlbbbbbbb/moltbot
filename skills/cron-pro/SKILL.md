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
      "message": "Please send the following text exactly as is, without adding anything else: 'Yihang, it's 8:00 AM! Time to wake up! ✨'",
      "deliver": true
    },
    "enabled": true
  }
}
```

## Critical Instruction Formatting

The `message` field in `agentTurn` is an **instruction to a sub-agent**, not the final text.

- **Bad**: `"message": "Test message!"` (The sub-agent might add "Sure, I'll send that: Test message!")
- **Good**: `"message": "Please send the following content exactly, do not add anything else: [TEXT]"`

## Scheduling Types

- `at`: One-shot. Requires `atMs` (Unix ms timestamp).
- `every`: Recurring interval. Requires `everyMs`.
- `cron`: Complex schedules. Requires `expr` (standard cron expression).
