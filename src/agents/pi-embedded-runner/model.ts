import type { Api, Model } from "@mariozechner/pi-ai";

import type { ClawdbotConfig } from "../../config/config.js";
import type { ModelDefinitionConfig } from "../../config/types.js";
import { resolveClawdbotAgentDir } from "../agent-paths.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { normalizeModelCompat } from "../model-compat.js";
import { normalizeProviderId } from "../model-selection.js";
import {
  discoverAuthStorage,
  discoverModels,
  type DiscoveredAuthStorage,
  type DiscoveredModelRegistry,
} from "../pi-sdk-discovery.js";

type InlineModelEntry = ModelDefinitionConfig & { provider: string };
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_SONNET_46_LATEST = "claude-sonnet-4-6";

function normalizeAnthropicSonnet46ModelId(modelId: string): string | null {
  const trimmed = modelId.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed === ANTHROPIC_SONNET_46_LATEST || trimmed === "claude-sonnet-4.6") {
    return ANTHROPIC_SONNET_46_LATEST;
  }
  const dated = /^claude-sonnet-4(?:-6|\.6)-(\d{8})$/.exec(trimmed);
  if (!dated) return null;
  return `${ANTHROPIC_SONNET_46_LATEST}-${dated[1]}`;
}

function buildAnthropicSonnet46FallbackModel(modelId: string): Model<Api> {
  const isLatest = modelId === ANTHROPIC_SONNET_46_LATEST;
  return {
    id: modelId,
    name: isLatest ? "Claude Sonnet 4.6 (latest)" : "Claude Sonnet 4.6",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: ANTHROPIC_BASE_URL,
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    },
    contextWindow: 200000,
    maxTokens: 64000,
  } as Model<Api>;
}

export function buildInlineProviderModels(
  providers: Record<string, { models?: ModelDefinitionConfig[]; api?: string; baseUrl?: string }>,
): InlineModelEntry[] {
  return Object.entries(providers).flatMap(([providerId, entry]) => {
    const trimmed = providerId.trim();
    if (!trimmed) return [];
    return (entry?.models ?? []).map((model) => ({
      ...model,
      provider: trimmed,
      api: model.api ?? (entry?.api as ModelDefinitionConfig["api"]),
      baseUrl: (model as Record<string, unknown>).baseUrl ?? entry?.baseUrl,
    })) as InlineModelEntry[];
  });
}

export function buildModelAliasLines(cfg?: ClawdbotConfig) {
  const models = cfg?.agents?.defaults?.models ?? {};
  const entries: Array<{ alias: string; model: string }> = [];
  for (const [keyRaw, entryRaw] of Object.entries(models)) {
    const model = String(keyRaw ?? "").trim();
    if (!model) continue;
    const alias = String((entryRaw as { alias?: string } | undefined)?.alias ?? "").trim();
    if (!alias) continue;
    entries.push({ alias, model });
  }
  return entries
    .sort((a, b) => a.alias.localeCompare(b.alias))
    .map((entry) => `- ${entry.alias}: ${entry.model}`);
}

export function resolveModel(
  provider: string,
  modelId: string,
  agentDir?: string,
  cfg?: ClawdbotConfig,
): {
  model?: Model<Api>;
  error?: string;
  authStorage: DiscoveredAuthStorage;
  modelRegistry: DiscoveredModelRegistry;
} {
  const resolvedAgentDir = agentDir ?? resolveClawdbotAgentDir();
  const authStorage = discoverAuthStorage(resolvedAgentDir);
  const modelRegistry = discoverModels(authStorage, resolvedAgentDir);
  const model = modelRegistry.find(provider, modelId) as Model<Api> | null;
  if (!model) {
    const providers = cfg?.models?.providers ?? {};
    const inlineModels = buildInlineProviderModels(providers);
    const normalizedProvider = normalizeProviderId(provider);
    const inlineMatch = inlineModels.find(
      (entry) => normalizeProviderId(entry.provider) === normalizedProvider && entry.id === modelId,
    );
    if (inlineMatch) {
      const normalized = normalizeModelCompat(inlineMatch as Model<Api>);
      return {
        model: normalized,
        authStorage,
        modelRegistry,
      };
    }
    const providerCfg = providers[provider];
    if (!providerCfg && normalizedProvider === "anthropic") {
      const anthropicModelId = normalizeAnthropicSonnet46ModelId(modelId);
      if (anthropicModelId) {
        // Keep Sonnet 4.6 usable while upstream model catalogs roll forward.
        const fallbackModel = normalizeModelCompat(
          buildAnthropicSonnet46FallbackModel(anthropicModelId),
        );
        return { model: fallbackModel, authStorage, modelRegistry };
      }
    }
    if (providerCfg || modelId.startsWith("mock-")) {
      const fallbackModel: Model<Api> = normalizeModelCompat({
        id: modelId,
        name: modelId,
        api: providerCfg?.api ?? "openai-responses",
        provider,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: providerCfg?.models?.[0]?.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
        maxTokens: providerCfg?.models?.[0]?.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
      } as Model<Api>);
      return { model: fallbackModel, authStorage, modelRegistry };
    }
    return {
      error: `Unknown model: ${provider}/${modelId}`,
      authStorage,
      modelRegistry,
    };
  }
  return { model: normalizeModelCompat(model), authStorage, modelRegistry };
}
