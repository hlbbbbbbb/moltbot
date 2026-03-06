import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const find = vi.fn();
  return {
    find,
    discoverAuthStorage: vi.fn(() => ({})),
    discoverModels: vi.fn(() => ({ find })),
  };
});

vi.mock("../pi-sdk-discovery.js", () => ({
  discoverAuthStorage: mocks.discoverAuthStorage,
  discoverModels: mocks.discoverModels,
}));

import { resolveModel } from "./model.js";

describe("resolveModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.find.mockReturnValue(null);
  });

  it("falls back to Anthropic Sonnet 4.6 when the SDK catalog is behind", () => {
    const result = resolveModel("anthropic", "claude-sonnet-4-6", "/tmp/clawdbot-agent", {});

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      id: "claude-sonnet-4-6",
      api: "anthropic-messages",
      provider: "anthropic",
      reasoning: true,
      contextWindow: 200000,
      maxTokens: 64000,
    });
  });

  it("normalizes dotted Sonnet 4.6 dated ids in fallback", () => {
    const result = resolveModel(
      "anthropic",
      "claude-sonnet-4.6-20260215",
      "/tmp/clawdbot-agent",
      {},
    );

    expect(result.error).toBeUndefined();
    expect(result.model?.id).toBe("claude-sonnet-4-6-20260215");
  });

  it("still reports unknown models when no fallback applies", () => {
    const result = resolveModel("anthropic", "claude-sonnet-4-9", "/tmp/clawdbot-agent", {});

    expect(result.model).toBeUndefined();
    expect(result.error).toBe("Unknown model: anthropic/claude-sonnet-4-9");
  });
});
