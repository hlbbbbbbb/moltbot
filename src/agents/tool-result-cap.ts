/**
 * Tool Result Capping — truncates oversized tool results before they
 * enter the session transcript, preventing context overflow.
 *
 * Strategy: keep 60% head + 30% tail of the content with a truncation
 * marker in between.  The full result is optionally cached to disk so
 * the agent can retrieve it with a `read` tool call later.
 */

import { cacheToolResult } from "./tool-result-cache.js";

export const DEFAULT_TOOL_RESULT_MAX_CHARS = 100_000;

export type CapResult = {
  content: string;
  wasCapped: boolean;
  originalLength: number;
  cachePath?: string;
};

/**
 * Cap a single tool result string to `maxChars`.
 * If the content exceeds the limit, the full output is written to a
 * per-session disk cache and the truncated content includes a pointer
 * to the cached file.
 */
export async function capToolResultContent(params: {
  content: string;
  toolName: string;
  toolCallId: string;
  sessionId: string;
  maxChars: number;
  cacheDir?: string;
}): Promise<CapResult> {
  const { content, maxChars } = params;

  if (content.length <= maxChars) {
    return { content, wasCapped: false, originalLength: content.length };
  }

  const headChars = Math.floor(maxChars * 0.6);
  const tailChars = Math.floor(maxChars * 0.3);

  const head = content.slice(0, headChars);
  const tail = content.slice(content.length - tailChars);

  let cachePath: string | undefined;
  if (params.cacheDir) {
    try {
      cachePath = await cacheToolResult({
        content,
        toolCallId: params.toolCallId,
        sessionId: params.sessionId,
        cacheDir: params.cacheDir,
      });
    } catch {
      // Cache write failure is non-fatal; continue with truncated output.
    }
  }

  const cacheNote = cachePath
    ? `\n[Full output cached at: ${cachePath} — use the read tool to access]`
    : "";

  const truncated =
    `${head}\n` +
    `\n... [Truncated: showing ${headChars} head + ${tailChars} tail of ${content.length} chars (tool: ${params.toolName})] ...\n\n` +
    `${tail}${cacheNote}`;

  return {
    content: truncated,
    wasCapped: true,
    originalLength: content.length,
    cachePath,
  };
}

/**
 * Synchronous version of capToolResultContent for use in synchronous
 * code paths (e.g., the session-tool-result-guard transform).
 * Does NOT write to disk cache — that can be done asynchronously after.
 */
export function capToolResultContentSync(params: {
  content: string;
  toolName: string;
  toolCallId: string;
  maxChars: number;
}): Omit<CapResult, "cachePath"> {
  const { content, maxChars } = params;

  if (content.length <= maxChars) {
    return { content, wasCapped: false, originalLength: content.length };
  }

  const headChars = Math.floor(maxChars * 0.6);
  const tailChars = Math.floor(maxChars * 0.3);

  const head = content.slice(0, headChars);
  const tail = content.slice(content.length - tailChars);

  const truncated =
    `${head}\n` +
    `\n... [Truncated: showing ${headChars} head + ${tailChars} tail of ${content.length} chars (tool: ${params.toolName})] ...\n\n` +
    tail;

  return {
    content: truncated,
    wasCapped: true,
    originalLength: content.length,
  };
}
