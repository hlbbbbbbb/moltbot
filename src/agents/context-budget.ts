/**
 * Context Budget System — central token budget calculator.
 *
 * Every pipeline stage (system prompt, bootstrap, history, images, hooks)
 * consumes from the budget.  A pre-flight check before the API call detects
 * overflow *before* the request is sent, enabling proactive compaction.
 *
 * Key design choice: multilingual-aware token estimation.  Chinese / CJK text
 * averages ~2.5 chars per token while Latin text averages ~4.  Using a fixed 4
 * underestimates CJK by ~40%, causing pruning to fire too late.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";

// ---------------------------------------------------------------------------
// CJK detection
// ---------------------------------------------------------------------------

/** Unicode ranges for CJK Unified Ideographs + common CJK blocks. */
const CJK_REGEX =
  // biome-ignore lint: complex regex for CJK detection
  /[\u2E80-\u2FFF\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u3100-\u312F\u3200-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F]/;

/**
 * Estimate the fraction of a string that consists of CJK characters.
 * Only samples the first 4 000 chars to keep it fast.
 */
export function estimateCjkRatio(text: string): number {
  if (!text) return 0;
  const sample = text.length > 4_000 ? text.slice(0, 4_000) : text;
  let cjkCount = 0;
  for (let i = 0; i < sample.length; i++) {
    if (CJK_REGEX.test(sample[i])) cjkCount++;
  }
  return cjkCount / sample.length;
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/** Chars-per-token for pure Latin / code content. */
const LATIN_CHARS_PER_TOKEN = 4;
/** Chars-per-token for CJK-heavy content (Chinese / Japanese / Korean). */
const CJK_CHARS_PER_TOKEN = 2.5;
/** Char estimate for a single image block (vision models). */
export const IMAGE_TOKEN_ESTIMATE = 2_000;

/**
 * Resolve the effective chars-per-token ratio for a piece of text,
 * interpolating between Latin and CJK based on actual content.
 */
export function resolveCharsPerToken(text: string): number {
  const ratio = estimateCjkRatio(text);
  // Linear interpolation: ratio=0 → 4, ratio=1 → 2.5
  return LATIN_CHARS_PER_TOKEN - ratio * (LATIN_CHARS_PER_TOKEN - CJK_CHARS_PER_TOKEN);
}

/**
 * Estimate token count for a string, accounting for CJK content.
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  const cpt = resolveCharsPerToken(text);
  return Math.ceil(text.length / cpt);
}

/**
 * Estimate tokens for a single AgentMessage (user / assistant / toolResult).
 * Uses the same heuristic as the pruner but with multilingual awareness.
 */
export function estimateMessageTokens(msg: AgentMessage): number {
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) return 0;

  let chars = 0;
  let images = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const rec = block as Record<string, unknown>;
    if (rec.type === "text" && typeof rec.text === "string") {
      chars += (rec.text as string).length;
    } else if (rec.type === "thinking" && typeof rec.thinking === "string") {
      chars += (rec.thinking as string).length;
    } else if (rec.type === "image" || rec.type === "image_url") {
      images++;
    } else if (rec.type === "toolCall" || rec.type === "toolUse" || rec.type === "functionCall") {
      // Count the arguments JSON
      const args = rec.arguments ?? rec.input ?? rec.args;
      if (typeof args === "string") chars += args.length;
      else if (args && typeof args === "object") chars += JSON.stringify(args).length;
    }
  }

  const cpt =
    chars > 0 ? resolveCharsPerToken(collectTextFromBlocks(content)) : LATIN_CHARS_PER_TOKEN;
  return Math.ceil(chars / cpt) + images * IMAGE_TOKEN_ESTIMATE;
}

/**
 * Estimate total tokens for an array of messages.
 */
export function estimateMessagesTokenCount(messages: AgentMessage[]): number {
  let total = 0;
  for (const msg of messages) total += estimateMessageTokens(msg);
  return total;
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export type ContextBudgetStage =
  | "systemPrompt"
  | "bootstrap"
  | "history"
  | "images"
  | "hooks"
  | "newPrompt";

export type ContextBudget = {
  totalTokens: number;
  reserveTokens: number;
  consumed: Record<string, number>;
  availableTokens: number;
};

export function createContextBudget(
  contextWindowTokens: number,
  reserveTokens: number,
): ContextBudget {
  return {
    totalTokens: contextWindowTokens,
    reserveTokens,
    consumed: {},
    availableTokens: contextWindowTokens - reserveTokens,
  };
}

export function consumeBudget(budget: ContextBudget, stage: string, tokens: number): ContextBudget {
  const consumed = { ...budget.consumed, [stage]: (budget.consumed[stage] ?? 0) + tokens };
  const totalConsumed = Object.values(consumed).reduce((a, b) => a + b, 0);
  return {
    ...budget,
    consumed,
    availableTokens: budget.totalTokens - budget.reserveTokens - totalConsumed,
  };
}

export type BudgetCheckResult = {
  fits: boolean;
  totalConsumed: number;
  usageRatio: number;
  overBy: number;
};

export function checkBudgetFits(budget: ContextBudget): BudgetCheckResult {
  const totalConsumed = Object.values(budget.consumed).reduce((a, b) => a + b, 0);
  const effectiveLimit = budget.totalTokens - budget.reserveTokens;
  const overBy = Math.max(0, totalConsumed - effectiveLimit);
  return {
    fits: overBy === 0,
    totalConsumed,
    usageRatio: totalConsumed / budget.totalTokens,
    overBy,
  };
}

// ---------------------------------------------------------------------------
// Pre-flight context estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the total token count for a prompt + messages + images,
 * suitable for a pre-flight check before calling the LLM API.
 */
export function estimateFullContextTokens(params: {
  systemPrompt: string;
  messages: AgentMessage[];
  promptText: string;
  imageCount?: number;
}): number {
  const systemTokens = estimateTokenCount(params.systemPrompt);
  const historyTokens = estimateMessagesTokenCount(params.messages);
  const promptTokens = estimateTokenCount(params.promptText);
  const imageTokens = (params.imageCount ?? 0) * IMAGE_TOKEN_ESTIMATE;
  return systemTokens + historyTokens + promptTokens + imageTokens;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectTextFromBlocks(content: unknown[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const rec = block as Record<string, unknown>;
    if (rec.type === "text" && typeof rec.text === "string") parts.push(rec.text as string);
    if (rec.type === "thinking" && typeof rec.thinking === "string")
      parts.push(rec.thinking as string);
  }
  return parts.join(" ");
}
