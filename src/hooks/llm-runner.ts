import { resolveAgentModelFallbacksOverride } from "../agents/agent-scope.js";
import { runWithModelFallback } from "../agents/model-fallback.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import type { ClawdbotConfig } from "../config/config.js";

export type HookLlmModelPlan = {
  provider: string;
  model: string;
  fallbacksOverride?: string[];
};

export function resolveHookLlmModelPlan(params: {
  cfg: ClawdbotConfig;
  agentId: string;
}): HookLlmModelPlan {
  const primary = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  return {
    provider: primary.provider,
    model: primary.model,
    fallbacksOverride: resolveAgentModelFallbacksOverride(params.cfg, params.agentId),
  };
}

export async function runHookLlmWithFallback<T>(params: {
  cfg: ClawdbotConfig;
  agentId: string;
  agentDir: string;
  run: (provider: string, model: string) => Promise<T>;
}) {
  const plan = resolveHookLlmModelPlan({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  return runWithModelFallback({
    cfg: params.cfg,
    provider: plan.provider,
    model: plan.model,
    agentDir: params.agentDir,
    fallbacksOverride: plan.fallbacksOverride,
    run: params.run,
  });
}
