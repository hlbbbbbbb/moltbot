import type { Api, Model } from "@mariozechner/pi-ai";

export type CompactionSafeguardRuntimeValue = {
  maxHistoryShare?: number;
  /** Dedicated model for compaction summarization (resolved from config). */
  compactionModel?: Model<Api>;
  /** Pre-resolved API key for the compaction model. */
  compactionApiKey?: string;
  /** Persistent structured summary for incremental compaction (anchored iterative). */
  previousStructuredSummary?: string;
};

// Session-scoped runtime registry keyed by object identity.
// Follows the same WeakMap pattern as context-pruning/runtime.ts.
const REGISTRY = new WeakMap<object, CompactionSafeguardRuntimeValue>();

export function setCompactionSafeguardRuntime(
  sessionManager: unknown,
  value: CompactionSafeguardRuntimeValue | null,
): void {
  if (!sessionManager || typeof sessionManager !== "object") {
    return;
  }

  const key = sessionManager as object;
  if (value === null) {
    REGISTRY.delete(key);
    return;
  }

  REGISTRY.set(key, value);
}

export function getCompactionSafeguardRuntime(
  sessionManager: unknown,
): CompactionSafeguardRuntimeValue | null {
  if (!sessionManager || typeof sessionManager !== "object") {
    return null;
  }

  return REGISTRY.get(sessionManager as object) ?? null;
}
