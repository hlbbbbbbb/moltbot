/**
 * Session memory hook handler
 *
 * Saves AI-generated session summaries when /new or /reset command is triggered
 * Creates structured summaries in summaries/ directory for better memory quality
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ClawdbotConfig } from "../../../config/config.js";
import { resolveAgentWorkspaceDir } from "../../../agents/agent-scope.js";
import { resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
import { resolveSessionTranscriptsDirForAgent } from "../../../config/sessions/paths.js";
import type { HookHandler } from "../../hooks.js";

/**
 * Find the most recently modified session file, excluding the current new session.
 * This is more reliable than depending on sessionStore which may be stale.
 */
async function findPreviousSessionFile(
  agentId: string,
  currentSessionId?: string,
): Promise<{ path: string; sessionId: string } | null> {
  try {
    const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
    const files = await fs.readdir(sessionsDir);
    const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

    // Get stats for all session files
    const fileStats = await Promise.all(
      jsonlFiles.map(async (file) => {
        const filePath = path.join(sessionsDir, file);
        try {
          const stat = await fs.stat(filePath);
          const sessionId = file.replace(".jsonl", "");
          return { file, filePath, sessionId, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      }),
    );

    // Filter out nulls and current session, sort by mtime descending
    const validFiles = fileStats
      .filter((f): f is NonNullable<typeof f> => f !== null)
      .filter((f) => !currentSessionId || f.sessionId !== currentSessionId)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    if (validFiles.length === 0) return null;

    // Return the most recently modified session file
    const mostRecent = validFiles[0];
    return { path: mostRecent.filePath, sessionId: mostRecent.sessionId };
  } catch (err) {
    console.error("[session-memory] Error finding previous session:", err);
    return null;
  }
}

/**
 * Read full session content from JSONL file
 */
async function getFullSessionContent(sessionFilePath: string): Promise<string | null> {
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
              // Truncate long messages (e.g. code blocks) but keep enough context
              const truncated = text.length > 2000 ? text.slice(0, 2000) + "..." : text;
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
 * Save session summary to memory when /new or /reset command is triggered
 */
const saveSessionToMemory: HookHandler = async (event) => {
  // Trigger only on 'new' command (reset is for discarding sessions without saving)
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  try {
    console.log(`[session-memory] Hook triggered for /${event.action} command`);

    const context = event.context || {};
    const cfg = context.cfg as ClawdbotConfig | undefined;
    const agentId = resolveAgentIdFromSessionKey(event.sessionKey);
    const workspaceDir = cfg
      ? resolveAgentWorkspaceDir(cfg, agentId)
      : path.join(os.homedir(), "clawd");

    // Use summaries/ directory for AI-generated summaries
    const summariesDir = path.join(workspaceDir, "summaries");
    await fs.mkdir(summariesDir, { recursive: true });

    const now = new Date(event.timestamp);
    const dateStr = now.toISOString().split("T")[0]; // YYYY-MM-DD
    const timeStr = now.toISOString().split("T")[1]!.split(".")[0]!.replace(/:/g, "");

    // Get session file path - prefer direct disk lookup for reliability
    const sessionEntry = (context.previousSessionEntry || context.sessionEntry || {}) as Record<
      string,
      unknown
    >;
    const newSessionId = (context.sessionEntry as Record<string, unknown> | undefined)?.sessionId as
      | string
      | undefined;
    const source = (context.commandSource as string) || "unknown";

    // Try to find the previous session file from disk (more reliable than sessionStore)
    let currentSessionFile: string | undefined;
    let sessionId: string = "unknown";

    const previousSession = await findPreviousSessionFile(agentId, newSessionId);
    if (previousSession) {
      currentSessionFile = previousSession.path;
      sessionId = previousSession.sessionId;
      console.log("[session-memory] Found previous session from disk:", currentSessionFile);
    } else {
      // Fallback to sessionEntry (legacy behavior)
      currentSessionFile = sessionEntry.sessionFile as string | undefined;
      sessionId = (sessionEntry.sessionId as string) || "unknown";
      console.log("[session-memory] Using sessionEntry fallback:", currentSessionFile);
    }

    if (!currentSessionFile) {
      console.log("[session-memory] No session file found, skipping");
      return;
    }

    // Read full session content
    const sessionContent = await getFullSessionContent(currentSessionFile);
    if (!sessionContent || sessionContent.length < 100) {
      console.log("[session-memory] Session too short, skipping summary generation");
      return;
    }

    console.log("[session-memory] Session content length:", sessionContent.length);

    let slug = timeStr.slice(0, 4); // Default to HHMM
    let title = "Session Summary";
    let summary = "";

    if (cfg) {
      try {
        console.log("[session-memory] Generating summary via LLM...");

        // Dynamically import summary generator
        const clawdbotRoot = path.resolve(
          path.dirname(import.meta.url.replace("file://", "")),
          "../..",
        );
        const summaryGenPath = path.join(clawdbotRoot, "llm-summary-generator.js");
        const { generateSummaryViaLLM } = await import(summaryGenPath);

        const result = await generateSummaryViaLLM({ sessionContent, cfg });

        if (result) {
          slug = result.slug || slug;
          title = result.title || title;
          summary = result.summary || "";
          console.log("[session-memory] Generated summary with slug:", slug);
        }
      } catch (err) {
        console.error("[session-memory] Summary generation failed:", err);
      }
    }

    // Build Markdown file content
    const filename = `${dateStr}-${slug}.md`;
    const summaryFilePath = path.join(summariesDir, filename);

    const markdownContent = [
      `# ${title}`,
      "",
      `> Date: ${dateStr} ${timeStr.slice(0, 2)}:${timeStr.slice(2, 4)} | Session: \`${sessionId.slice(0, 8)}\` | Source: ${source}`,
      "",
      summary || "(Failed to generate summary)",
      "",
      "---",
      `*Original session: \`~/.clawdbot/agents/${agentId}/sessions/${path.basename(currentSessionFile)}\`*`,
    ].join("\n");

    // Write summary file
    await fs.writeFile(summaryFilePath, markdownContent, "utf-8");

    const relPath = summaryFilePath.replace(os.homedir(), "~");
    console.log(`[session-memory] Summary saved to ${relPath}`);
  } catch (err) {
    console.error(
      "[session-memory] Failed to save session memory:",
      err instanceof Error ? err.message : String(err),
    );
  }
};

export default saveSessionToMemory;
