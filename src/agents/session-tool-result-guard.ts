import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";

import { makeMissingToolResult } from "./session-transcript-repair.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { capToolResultContentSync, DEFAULT_TOOL_RESULT_MAX_CHARS } from "./tool-result-cap.js";

type ToolCall = { id: string; name?: string };

function extractAssistantToolCalls(msg: Extract<AgentMessage, { role: "assistant" }>): ToolCall[] {
  const content = msg.content;
  if (!Array.isArray(content)) return [];

  const toolCalls: ToolCall[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const rec = block as { type?: unknown; id?: unknown; name?: unknown };
    if (typeof rec.id !== "string" || !rec.id) continue;
    if (rec.type === "toolCall" || rec.type === "toolUse" || rec.type === "functionCall") {
      toolCalls.push({
        id: rec.id,
        name: typeof rec.name === "string" ? rec.name : undefined,
      });
    }
  }
  return toolCalls;
}

function extractToolResultId(msg: Extract<AgentMessage, { role: "toolResult" }>): string | null {
  const toolCallId = (msg as { toolCallId?: unknown }).toolCallId;
  if (typeof toolCallId === "string" && toolCallId) return toolCallId;
  const toolUseId = (msg as { toolUseId?: unknown }).toolUseId;
  if (typeof toolUseId === "string" && toolUseId) return toolUseId;
  return null;
}

export function installSessionToolResultGuard(
  sessionManager: SessionManager,
  opts?: {
    /**
     * Optional, synchronous transform applied to toolResult messages *before* they are
     * persisted to the session transcript.
     */
    transformToolResultForPersistence?: (
      message: AgentMessage,
      meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean },
    ) => AgentMessage;
    /**
     * Whether to synthesize missing tool results to satisfy strict providers.
     * Defaults to true.
     */
    allowSyntheticToolResults?: boolean;
    /**
     * Max chars for a single tool result before truncation.
     * Defaults to DEFAULT_TOOL_RESULT_MAX_CHARS (100K).
     */
    toolResultMaxChars?: number;
  },
): {
  flushPendingToolResults: () => void;
  getPendingIds: () => string[];
} {
  const originalAppend = sessionManager.appendMessage.bind(sessionManager);
  const pending = new Map<string, string | undefined>();

  const maxChars = opts?.toolResultMaxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS;

  const persistToolResult = (
    message: AgentMessage,
    meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean },
  ) => {
    // Cap oversized tool results before persistence to prevent context overflow.
    let capped = message;
    if (message.role === "toolResult" && !meta.isSynthetic) {
      capped = capToolResultMessage(message, meta, maxChars);
    }
    const transformer = opts?.transformToolResultForPersistence;
    return transformer ? transformer(capped, meta) : capped;
  };

  const allowSyntheticToolResults = opts?.allowSyntheticToolResults ?? true;

  const flushPendingToolResults = () => {
    if (pending.size === 0) return;
    if (allowSyntheticToolResults) {
      for (const [id, name] of pending.entries()) {
        const synthetic = makeMissingToolResult({ toolCallId: id, toolName: name });
        originalAppend(
          persistToolResult(synthetic, {
            toolCallId: id,
            toolName: name,
            isSynthetic: true,
          }) as never,
        );
      }
    }
    pending.clear();
  };

  const guardedAppend = (message: AgentMessage) => {
    const role = (message as { role?: unknown }).role;

    if (role === "toolResult") {
      const id = extractToolResultId(message as Extract<AgentMessage, { role: "toolResult" }>);
      const toolName = id ? pending.get(id) : undefined;
      if (id) pending.delete(id);
      return originalAppend(
        persistToolResult(message, {
          toolCallId: id ?? undefined,
          toolName,
          isSynthetic: false,
        }) as never,
      );
    }

    const toolCalls =
      role === "assistant"
        ? extractAssistantToolCalls(message as Extract<AgentMessage, { role: "assistant" }>)
        : [];

    if (allowSyntheticToolResults) {
      // If previous tool calls are still pending, flush before non-tool results.
      if (pending.size > 0 && (toolCalls.length === 0 || role !== "assistant")) {
        flushPendingToolResults();
      }
      // If new tool calls arrive while older ones are pending, flush the old ones first.
      if (pending.size > 0 && toolCalls.length > 0) {
        flushPendingToolResults();
      }
    }

    const result = originalAppend(message as never);

    const sessionFile = (
      sessionManager as { getSessionFile?: () => string | null }
    ).getSessionFile?.();
    if (sessionFile) {
      emitSessionTranscriptUpdate(sessionFile);
    }

    if (toolCalls.length > 0) {
      for (const call of toolCalls) {
        pending.set(call.id, call.name);
      }
    }

    return result;
  };

  // Monkey-patch appendMessage with our guarded version.
  sessionManager.appendMessage = guardedAppend as SessionManager["appendMessage"];

  return {
    flushPendingToolResults,
    getPendingIds: () => Array.from(pending.keys()),
  };
}

/** Cap tool result text blocks that exceed maxChars. */
function capToolResultMessage(
  message: AgentMessage,
  meta: { toolCallId?: string; toolName?: string },
  maxChars: number,
): AgentMessage {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return message;

  let changed = false;
  const newContent = content.map((block: Record<string, unknown>) => {
    if (block?.type !== "text" || typeof block.text !== "string") return block;
    const text = block.text as string;
    if (text.length <= maxChars) return block;

    const result = capToolResultContentSync({
      content: text,
      toolName: meta.toolName ?? "unknown",
      toolCallId: meta.toolCallId ?? "unknown",
      maxChars,
    });
    if (!result.wasCapped) return block;
    changed = true;
    return { ...block, text: result.content };
  });

  return changed ? ({ ...message, content: newContent } as unknown as AgentMessage) : message;
}
