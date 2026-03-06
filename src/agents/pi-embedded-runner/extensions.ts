import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Api, Model } from "@mariozechner/pi-ai";
import type { SessionManager } from "@mariozechner/pi-coding-agent";

import type { ClawdbotConfig } from "../../config/config.js";
import { resolveContextWindowInfo } from "../context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { getApiKeyForModel } from "../model-auth.js";
import { setCompactionSafeguardRuntime } from "../pi-extensions/compaction-safeguard-runtime.js";
import { setContextPruningRuntime } from "../pi-extensions/context-pruning/runtime.js";
import { computeEffectiveSettings } from "../pi-extensions/context-pruning/settings.js";
import { makeToolPrunablePredicate } from "../pi-extensions/context-pruning/tools.js";
import { ensurePiCompactionReserveTokens } from "../pi-settings.js";
import { isCacheTtlEligibleProvider, readLastCacheTtlTimestamp } from "./cache-ttl.js";
import { resolveModel } from "./model.js";

function resolvePiExtensionPath(id: string): string {
  const self = fileURLToPath(import.meta.url);
  const dir = path.dirname(self);
  // In dev this file is `.ts` (tsx), in production it's `.js`.
  const ext = path.extname(self) === ".ts" ? "ts" : "js";
  return path.join(dir, "..", "pi-extensions", `${id}.${ext}`);
}

function resolveContextWindowTokens(params: {
  cfg: ClawdbotConfig | undefined;
  provider: string;
  modelId: string;
  model: Model<Api> | undefined;
}): number {
  return resolveContextWindowInfo({
    cfg: params.cfg,
    provider: params.provider,
    modelId: params.modelId,
    modelContextWindow: params.model?.contextWindow,
    defaultTokens: DEFAULT_CONTEXT_TOKENS,
  }).tokens;
}

function buildContextPruningExtension(params: {
  cfg: ClawdbotConfig | undefined;
  sessionManager: SessionManager;
  provider: string;
  modelId: string;
  model: Model<Api> | undefined;
}): { additionalExtensionPaths?: string[] } {
  const raw = params.cfg?.agents?.defaults?.contextPruning;
  if (raw?.mode !== "cache-ttl") return {};
  if (!isCacheTtlEligibleProvider(params.provider, params.modelId)) return {};

  const settings = computeEffectiveSettings(raw);
  if (!settings) return {};

  setContextPruningRuntime(params.sessionManager, {
    settings,
    contextWindowTokens: resolveContextWindowTokens(params),
    isToolPrunable: makeToolPrunablePredicate(settings.tools),
    lastCacheTouchAt: readLastCacheTtlTimestamp(params.sessionManager),
  });

  return {
    additionalExtensionPaths: [resolvePiExtensionPath("context-pruning")],
  };
}

function resolveCompactionMode(cfg?: ClawdbotConfig): "default" | "safeguard" {
  return cfg?.agents?.defaults?.compaction?.mode === "safeguard" ? "safeguard" : "default";
}

/**
 * Parse a "provider/modelId" string into its parts.
 * Returns null if the string is empty or malformed.
 */
function parseModelRef(ref: string): { provider: string; modelId: string } | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const slashIdx = trimmed.indexOf("/");
  if (slashIdx <= 0) return null;
  return {
    provider: trimmed.slice(0, slashIdx),
    modelId: trimmed.slice(slashIdx + 1),
  };
}

/**
 * Try to resolve a compaction model from a list of candidate refs (primary + fallbacks).
 * Returns the first model that resolves successfully with a valid API key.
 */
async function resolveCompactionModel(params: {
  candidates: string[];
  agentDir?: string;
  authProfileId?: string;
  cfg?: ClawdbotConfig;
}): Promise<{ model: Model<Api>; apiKey: string } | null> {
  for (const ref of params.candidates) {
    const parsed = parseModelRef(ref);
    if (!parsed) continue;

    const resolved = resolveModel(parsed.provider, parsed.modelId, params.agentDir, params.cfg);
    if (!resolved.model) continue;

    try {
      const keyInfo = await getApiKeyForModel({
        model: resolved.model,
        cfg: params.cfg,
        profileId: params.authProfileId,
        agentDir: params.agentDir,
      });
      if (keyInfo.apiKey) {
        return { model: resolved.model, apiKey: keyInfo.apiKey };
      }
    } catch {
      // Try next candidate
    }
  }
  return null;
}

export async function buildEmbeddedExtensionPaths(params: {
  cfg: ClawdbotConfig | undefined;
  sessionManager: SessionManager;
  provider: string;
  modelId: string;
  model: Model<Api> | undefined;
  agentDir?: string;
  authProfileId?: string;
}): Promise<string[]> {
  const paths: string[] = [];
  if (resolveCompactionMode(params.cfg) === "safeguard") {
    const compactionCfg = params.cfg?.agents?.defaults?.compaction;

    // Resolve dedicated compaction model if configured
    let compactionModel: Model<Api> | undefined;
    let compactionApiKey: string | undefined;

    if (compactionCfg?.model?.primary) {
      const candidates = [compactionCfg.model.primary, ...(compactionCfg.model.fallbacks ?? [])];
      const resolved = await resolveCompactionModel({
        candidates,
        agentDir: params.agentDir,
        authProfileId: params.authProfileId,
        cfg: params.cfg,
      });
      if (resolved) {
        compactionModel = resolved.model;
        compactionApiKey = resolved.apiKey;
      }
    }

    setCompactionSafeguardRuntime(params.sessionManager, {
      maxHistoryShare: compactionCfg?.maxHistoryShare,
      compactionModel,
      compactionApiKey,
    });
    paths.push(resolvePiExtensionPath("compaction-safeguard"));
  }
  const pruning = buildContextPruningExtension(params);
  if (pruning.additionalExtensionPaths) {
    paths.push(...pruning.additionalExtensionPaths);
  }
  return paths;
}

export { ensurePiCompactionReserveTokens };
