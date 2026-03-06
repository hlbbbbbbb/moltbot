/**
 * Persistent Tool Result Pruner
 *
 * After each turn completes, replaces old tool results in the session .jsonl file
 * with compact placeholders. The assistant's reply serves as the natural summary
 * of the tool result, so the raw output becomes redundant once processed.
 *
 * This prevents session files from growing unboundedly with large tool outputs
 * (exec logs, browser content, etc.) that cause context overflow on reload.
 */

import fs from "node:fs";

export type PersistentPruneOptions = {
  /** Number of recent assistant messages whose tool results are protected. Default: 3. */
  keepLastAssistants?: number;
  /** Minimum chars in a tool result to be worth replacing. Default: 500. */
  minCharsToReplace?: number;
};

const DEFAULT_KEEP_LAST_ASSISTANTS = 3;
const DEFAULT_MIN_CHARS_TO_REPLACE = 500;
const PLACEHOLDER_PREFIX = "[Tool result from ";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ContentBlock = { type: string; text?: string; data?: string; [key: string]: unknown };

interface ParsedEntry {
  /** The raw parsed JSON object (full entry). */
  raw: Record<string, unknown>;
  /** Index of this entry in the lines array. */
  lineIndex: number;
}

interface MessageMeta {
  role: string;
  toolName?: string;
  toolCallId?: string;
  toolUseId?: string;
  content?: ContentBlock[];
}

function getMessageMeta(entry: Record<string, unknown>): MessageMeta | null {
  if (entry.type !== "message") return null;
  const msg = entry.message as Record<string, unknown> | undefined;
  if (!msg || typeof msg !== "object") return null;
  const role = msg.role as string | undefined;
  if (!role) return null;
  return {
    role,
    toolName: typeof msg.toolName === "string" ? msg.toolName : undefined,
    toolCallId: typeof msg.toolCallId === "string" ? msg.toolCallId : undefined,
    toolUseId: typeof msg.toolUseId === "string" ? msg.toolUseId : undefined,
    content: Array.isArray(msg.content) ? (msg.content as ContentBlock[]) : undefined,
  };
}

function hasImageBlocks(content: ContentBlock[] | undefined): boolean {
  if (!content) return false;
  for (const block of content) {
    if (block.type === "image" || block.type === "image_url") return true;
  }
  return false;
}

function estimateTextLength(content: ContentBlock[] | undefined): number {
  if (!content) return 0;
  let len = 0;
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      len += block.text.length;
    }
  }
  return len;
}

function isAlreadyPlaceholder(content: ContentBlock[] | undefined): boolean {
  if (!content || content.length === 0) return false;
  if (content.length !== 1) return false;
  const block = content[0];
  return (
    block.type === "text" &&
    typeof block.text === "string" &&
    block.text.startsWith(PLACEHOLDER_PREFIX)
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Persistently replace old tool results in a session .jsonl file with compact
 * placeholders. Only replaces tool results from turns that already have a
 * corresponding assistant response after them — i.e., the assistant has already
 * processed them and its reply serves as the natural summary.
 *
 * @returns The number of tool results replaced, or 0 if no changes were made.
 */
export function pruneSessionFileToolResults(
  sessionFile: string,
  opts?: PersistentPruneOptions,
): number {
  const keepLast = opts?.keepLastAssistants ?? DEFAULT_KEEP_LAST_ASSISTANTS;
  const minChars = opts?.minCharsToReplace ?? DEFAULT_MIN_CHARS_TO_REPLACE;

  // Read and parse each line
  let content: string;
  try {
    content = fs.readFileSync(sessionFile, "utf8");
  } catch {
    return 0;
  }

  const lines = content.split("\n");
  // Remove trailing empty line if present (common for .jsonl)
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  if (lines.length === 0) return 0;

  const parsed: ParsedEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    try {
      parsed.push({ raw: JSON.parse(line) as Record<string, unknown>, lineIndex: i });
    } catch {
      // Keep unparseable lines as-is
    }
  }

  // Find assistant message entry indices (in parsed array) for cutoff calculation
  const assistantParsedIndices: number[] = [];
  let firstUserParsedIndex: number | null = null;

  for (let pi = 0; pi < parsed.length; pi++) {
    const meta = getMessageMeta(parsed[pi].raw);
    if (!meta) continue;
    if (meta.role === "user" && firstUserParsedIndex === null) {
      firstUserParsedIndex = pi;
    }
    if (meta.role === "assistant") {
      assistantParsedIndices.push(pi);
    }
  }

  // Need more than keepLast assistant messages to have anything to prune
  if (assistantParsedIndices.length <= keepLast) return 0;

  // Cutoff: everything before the Nth-from-last assistant is eligible for pruning
  const cutoffParsedIndex = assistantParsedIndices[assistantParsedIndices.length - keepLast];

  let replacedCount = 0;

  for (let pi = 0; pi < cutoffParsedIndex; pi++) {
    const entry = parsed[pi];
    const meta = getMessageMeta(entry.raw);
    if (!meta || meta.role !== "toolResult") continue;

    // Skip bootstrap: entries before first user message
    if (firstUserParsedIndex !== null && pi < firstUserParsedIndex) continue;

    // Skip image-containing results
    if (hasImageBlocks(meta.content)) continue;

    // Skip already-replaced
    if (isAlreadyPlaceholder(meta.content)) continue;

    // Skip small results
    const textLen = estimateTextLength(meta.content);
    if (textLen < minChars) continue;

    // Build placeholder
    const toolName = meta.toolName ?? "unknown";
    const placeholder = `${PLACEHOLDER_PREFIX}${toolName}: ${textLen} chars — see assistant reply for details]`;

    // Replace content in the raw entry, preserving all other fields
    const msg = entry.raw.message as Record<string, unknown>;
    const newMsg = { ...msg, content: [{ type: "text", text: placeholder }] };
    const newEntry = { ...entry.raw, message: newMsg };

    lines[entry.lineIndex] = JSON.stringify(newEntry);
    replacedCount++;
  }

  if (replacedCount === 0) return 0;

  // Atomic write: write to .tmp then rename
  const tmpFile = `${sessionFile}.prune.tmp`;
  fs.writeFileSync(tmpFile, lines.join("\n") + "\n");
  fs.renameSync(tmpFile, sessionFile);

  return replacedCount;
}
