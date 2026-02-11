/**
 * LLM-based session summary generator
 *
 * Generates structured summaries from session conversations,
 * filtering out noise and extracting key information.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import type { ClawdbotConfig } from "../config/config.js";
import {
  resolveDefaultAgentId,
  resolveAgentWorkspaceDir,
  resolveAgentDir,
} from "../agents/agent-scope.js";
import { runHookLlmWithFallback } from "./llm-runner.js";

export type SessionSummary = {
  slug: string; // Short identifier for filename
  title: string; // Session title
  summary: string; // Full Markdown summary
};

/**
 * Read full session content from JSONL file
 */
export async function getFullSessionContent(sessionFilePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(sessionFilePath, "utf-8");
    const lines = content.trim().split("\n");

    const messages: string[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "message" && entry.message) {
          const msg = entry.message;
          const role = msg.role;
          if ((role === "user" || role === "assistant") && msg.content) {
            const text = Array.isArray(msg.content)
              ? msg.content.find((c: any) => c.type === "text")?.text
              : msg.content;
            if (text && !text.startsWith("/")) {
              // Truncate long messages (e.g. code blocks)
              const truncated = text.length > 1000 ? text.slice(0, 1000) + "..." : text;
              messages.push(`${role}: ${truncated}`);
            }
          }
        }
      } catch {
        // Skip invalid JSON lines
      }
    }

    return messages.join("\n\n");
  } catch {
    return null;
  }
}

/**
 * Generate a structured summary from session content using LLM
 */
export async function generateSummaryViaLLM(params: {
  sessionContent: string;
  cfg: ClawdbotConfig;
}): Promise<SessionSummary | null> {
  let tempSessionFile: string | null = null;

  try {
    const agentId = resolveDefaultAgentId(params.cfg);
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
    const agentDir = resolveAgentDir(params.cfg, agentId);

    // Create a temporary session file for this one-off LLM call
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-summary-"));
    tempSessionFile = path.join(tempDir, "session.jsonl");
    const sessionFile = tempSessionFile;

    // Limit input length to avoid exceeding context window
    const maxChars = 20000;
    const truncatedContent =
      params.sessionContent.length > maxChars
        ? params.sessionContent.slice(0, maxChars) + "\n\n[...conversation truncated...]"
        : params.sessionContent;

    const prompt = `Analyze the following conversation and generate a structured summary.

## Conversation:
${truncatedContent}

## Output format (follow strictly):

SLUG: <1-3 english words, hyphen-separated, e.g. api-design, meeting-notes, shopping-trip>

TITLE: <Short descriptive title for this session>

SUMMARY:
### What Happened
<Summarize what happened during this conversation/session>
<Include: what was done, where it happened, who was involved, the sequence of events>
<This is like a diary entry - capture the story of what occurred>

### Key Decisions
<List important decisions or choices made>
<If none, write "None">

### Problems Solved
<What problems were solved and how>
<If none, write "None">

### Important Information
<Record info worth remembering long-term>
<Examples: names, places, accounts, configs, contacts, preferences, facts learned>

### TODO Items
<If any, list follow-up tasks or things to remember to do>
<If none, write "None">

---

Notes:
- Ignore casual chat like "ok", "let me see", "thanks"
- Ignore large code blocks and debug output
- Focus on the narrative: what happened, who, where, when, why
- Extract facts that would be useful to recall later
- Write in a way that helps future recall of this day's events`;

    const runStartedAt = Date.now();
    const sessionId = `summary-generator-${runStartedAt}`;
    const runId = `summary-gen-${runStartedAt}`;
    const fallbackResult = await runHookLlmWithFallback({
      cfg: params.cfg,
      agentId,
      agentDir,
      run: (provider, model) =>
        runEmbeddedPiAgent({
          sessionId,
          sessionKey: "temp:summary-generator",
          sessionFile,
          workspaceDir,
          agentDir,
          config: params.cfg,
          prompt,
          provider,
          model,
          timeoutMs: 60_000, // 60 second timeout (longer than slug generation)
          runId,
        }),
    });
    const result = fallbackResult.result;

    // Extract text from payloads
    if (result.payloads && result.payloads.length > 0) {
      const text = result.payloads[0]?.text;
      if (text) {
        return parseSummaryResponse(text);
      }
    }

    return null;
  } catch (err) {
    console.error("[llm-summary-generator] Failed to generate summary:", err);
    return null;
  } finally {
    // Clean up temporary session file
    if (tempSessionFile) {
      try {
        await fs.rm(path.dirname(tempSessionFile), { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

/**
 * Parse the LLM response into structured summary
 */
function parseSummaryResponse(text: string): SessionSummary | null {
  try {
    // Extract SLUG
    const slugMatch = text.match(/SLUG:\s*(.+)/i);
    const slug =
      slugMatch?.[1]
        ?.trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 30) || "session";

    // Extract TITLE
    const titleMatch = text.match(/TITLE:\s*(.+)/i);
    const title = titleMatch?.[1]?.trim() || "Session Summary";

    // Extract SUMMARY (everything after SUMMARY:)
    const summaryMatch = text.match(/SUMMARY:\s*([\s\S]*)/i);
    const summary = summaryMatch?.[1]?.trim() || text;

    return { slug, title, summary };
  } catch {
    return null;
  }
}
