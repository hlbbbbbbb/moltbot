import { describe, expect, it } from "vitest";
import { DEFAULT_GATEWAY_PORT, type ClawdbotConfig } from "../config/config.js";
import { isAddressInUseError, resolveGmailWatcherRuntimeConfigs } from "./gmail-watcher.js";

describe("gmail watcher", () => {
  it("detects address already in use errors", () => {
    expect(isAddressInUseError("listen tcp 127.0.0.1:8788: bind: address already in use")).toBe(
      true,
    );
    expect(isAddressInUseError("EADDRINUSE: address already in use")).toBe(true);
    expect(isAddressInUseError("some other error")).toBe(false);
  });

  it("resolves root + accounts[] runtime configs with merged defaults", () => {
    const cfg = {
      hooks: {
        enabled: true,
        path: "/hooks",
        token: "hook-token",
        gmail: {
          account: "a@gmail.com",
          topic: "projects/demo/topics/gog-gmail-watch",
          pushToken: "push-a",
          serve: {
            bind: "127.0.0.1",
            port: 8788,
            path: "/gmail-pubsub",
          },
          tailscale: { mode: "off" },
          accounts: [
            {
              id: "monash",
              account: "b@student.monash.edu",
              pushToken: "push-b",
              serve: { port: 8789 },
            },
          ],
        },
      },
    } satisfies ClawdbotConfig;

    const result = resolveGmailWatcherRuntimeConfigs(cfg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.map((v) => v.key)).toEqual(["monash", "a@gmail.com"]);

    const monash = result.value.find((v) => v.key === "monash");
    expect(monash?.config.account).toBe("b@student.monash.edu");
    expect(monash?.config.serve.bind).toBe("127.0.0.1");
    expect(monash?.config.serve.port).toBe(8789);
    expect(monash?.config.serve.path).toBe("/gmail-pubsub");
    expect(monash?.config.hookUrl).toBe(`http://127.0.0.1:${DEFAULT_GATEWAY_PORT}/hooks/gmail`);
  });

  it("skips duplicate accounts (case-insensitive)", () => {
    const cfg = {
      hooks: {
        enabled: true,
        token: "hook-token",
        gmail: {
          account: "A@gmail.com",
          topic: "projects/demo/topics/gog-gmail-watch",
          pushToken: "push-a",
          accounts: [
            {
              id: "dup",
              account: "a@gmail.com",
              pushToken: "push-dup",
            },
          ],
        },
      },
    } satisfies ClawdbotConfig;

    const result = resolveGmailWatcherRuntimeConfigs(cfg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes("duplicate account configured"))).toBe(true);
  });

  it("falls back to account key when watcher ids collide", () => {
    const cfg = {
      hooks: {
        enabled: true,
        token: "hook-token",
        gmail: {
          topic: "projects/demo/topics/gog-gmail-watch",
          // Root config fields act as defaults for accounts[] entries.
          accounts: [
            {
              id: "same",
              account: "first@gmail.com",
              pushToken: "push-1",
            },
            {
              id: "same",
              account: "second@gmail.com",
              pushToken: "push-2",
            },
          ],
        },
      },
    } satisfies ClawdbotConfig;

    const result = resolveGmailWatcherRuntimeConfigs(cfg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.map((v) => v.key)).toEqual(["same", "second@gmail.com"]);
    expect(result.warnings.some((w) => w.includes("duplicate watcher key"))).toBe(true);
  });
});
