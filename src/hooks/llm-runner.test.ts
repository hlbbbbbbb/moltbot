import { describe, expect, it } from "vitest";
import { FailoverError } from "../agents/failover-error.js";
import type { ClawdbotConfig } from "../config/config.js";
import { resolveHookLlmModelPlan, runHookLlmWithFallback } from "./llm-runner.js";

describe("llm runner", () => {
  it("resolves per-agent model plan with fallback override", () => {
    const cfg: ClawdbotConfig = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.2",
            fallbacks: ["anthropic/claude-sonnet-4-5"],
          },
        },
        list: [
          {
            id: "mail-agent",
            model: {
              primary: "kimi-code/kimi-for-coding",
              fallbacks: ["openai/gpt-5.2"],
            },
          },
        ],
      },
    };

    expect(resolveHookLlmModelPlan({ cfg, agentId: "mail-agent" })).toEqual({
      provider: "kimi-code",
      model: "kimi-for-coding",
      fallbacksOverride: ["openai/gpt-5.2"],
    });
  });

  it("falls back to the next model when primary fails", async () => {
    const cfg: ClawdbotConfig = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.2",
            fallbacks: ["kimi-code/kimi-for-coding"],
          },
        },
      },
    };
    const attempts: string[] = [];

    const result = await runHookLlmWithFallback({
      cfg,
      agentId: "main",
      agentDir: "/tmp/clawdbot-test-agent",
      run: async (provider, model) => {
        const ref = `${provider}/${model}`;
        attempts.push(ref);
        if (ref === "openai/gpt-5.2") {
          throw new FailoverError("timed out", {
            reason: "timeout",
            provider,
            model,
          });
        }
        return `ok:${ref}`;
      },
    });

    expect(attempts).toEqual(["openai/gpt-5.2", "kimi-code/kimi-for-coding"]);
    expect(result.provider).toBe("kimi-code");
    expect(result.model).toBe("kimi-for-coding");
    expect(result.result).toBe("ok:kimi-code/kimi-for-coding");
    expect(result.attempts).toHaveLength(1);
  });
});
