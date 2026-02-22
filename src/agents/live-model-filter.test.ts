import { describe, expect, it } from "vitest";

import { isModernModelRef } from "./live-model-filter.js";

describe("isModernModelRef", () => {
  it("treats Anthropic Sonnet 4.6 as modern", () => {
    expect(isModernModelRef({ provider: "anthropic", id: "claude-sonnet-4-6" })).toBe(true);
  });

  it("treats OpenRouter Anthropic Sonnet 4.6 as modern", () => {
    expect(
      isModernModelRef({
        provider: "openrouter",
        id: "anthropic/claude-sonnet-4-6",
      }),
    ).toBe(true);
  });

  it("treats OpenRouter Anthropic Sonnet 4.6 dotted ids as modern", () => {
    expect(
      isModernModelRef({
        provider: "openrouter",
        id: "anthropic/claude-sonnet-4.6",
      }),
    ).toBe(true);
  });
});
