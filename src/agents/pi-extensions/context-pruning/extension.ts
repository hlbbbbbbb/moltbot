import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { pruneContextMessages } from "./pruner.js";
import { getContextPruningRuntime } from "./runtime.js";

export default function contextPruningExtension(api: ExtensionAPI): void {
  api.on("context", (event: ContextEvent, ctx: ExtensionContext) => {
    const runtime = getContextPruningRuntime(ctx.sessionManager);
    if (!runtime) return undefined;

    if (runtime.settings.mode === "cache-ttl") {
      const ttlMs = runtime.settings.ttlMs;
      const lastTouch = runtime.lastCacheTouchAt ?? null;
      if (ttlMs <= 0) {
        return undefined;
      }
      // Skip pruning only when cache is still fresh (lastTouch exists and TTL hasn't expired).
      // When lastTouch is null (first invocation), always run pruning to prevent overflow
      // from large initial tool results that haven't been pruned yet.
      if (lastTouch && Date.now() - lastTouch < ttlMs) {
        return undefined;
      }
    }

    const next = pruneContextMessages({
      messages: event.messages as AgentMessage[],
      settings: runtime.settings,
      ctx,
      isToolPrunable: runtime.isToolPrunable,
      contextWindowTokensOverride: runtime.contextWindowTokens ?? undefined,
    });

    if (next === event.messages) return undefined;

    if (runtime.settings.mode === "cache-ttl") {
      runtime.lastCacheTouchAt = Date.now();
    }

    return { messages: next };
  });
}
