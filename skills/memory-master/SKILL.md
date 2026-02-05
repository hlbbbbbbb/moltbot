---
name: memory-master
description: Strategy and logic for searching long-term memory and session history. Includes rules for handling relative time (e.g., "yesterday morning") and prioritizing different search tools. Use when you need to recall past events, decisions, or user preferences.
---

# Memory Master Skill

## Search Priority Logic

1. **Semantic Search (`memory_search`)**: Primary method. Good for broad keywords and concepts.
2. **Time-based Retrieval**: If the user provides a time (e.g., "this morning", "Jan 28"), prioritize reading `summaries/` or `memory/YYYY-MM-DD.md` for that day.
3. **Event Search**: If asking "what happened", check `summaries/` first as they aggregate events.
4. **Exact Quote**: Use `read` on specific session files if you need precise wording.

## Handling Relative Time

**Crucial: Convert relative time to absolute time before searching.**

- "Today morning" -> Current Date + `00 01 02 ... 11`
- "Yesterday evening" -> Yesterday's Date + `18 19 20 ... 23`
- "The day before yesterday" -> Date - 2 days.

**Why?** Memory files use timestamped lines. Querying for "yesterday" will likely fail or return irrelevant results.

## Search Query Best Practices

- Include the **absolute date** in the query string (e.g., `2026-01-30 workout`).
- For `memory_search`, use descriptive keywords rather than full sentences.
- If results are empty, try expanding keywords or searching `summaries/` directly.
