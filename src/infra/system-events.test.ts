import { beforeEach, describe, expect, it } from "vitest";

import { prependSystemEvents } from "../auto-reply/reply/session-updates.js";
import type { ClawdbotConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import {
  enqueueSystemEvent,
  getLatestSystemEventSeq,
  peekSystemEventEntriesSince,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "./system-events.js";

const cfg = {} as unknown as ClawdbotConfig;
const mainKey = resolveMainSessionKey(cfg);

describe("system events (session routing)", () => {
  beforeEach(() => {
    resetSystemEventsForTest();
  });

  it("does not leak session-scoped events into main", async () => {
    enqueueSystemEvent("Discord reaction added: ✅", {
      sessionKey: "discord:group:123",
      contextKey: "discord:reaction:added:msg:user:✅",
    });

    expect(peekSystemEvents(mainKey)).toEqual([]);
    expect(peekSystemEvents("discord:group:123")).toEqual(["Discord reaction added: ✅"]);

    const main = await prependSystemEvents({
      cfg,
      sessionKey: mainKey,
      isMainSession: true,
      isNewSession: false,
      prefixedBodyBase: "hello",
    });
    expect(main).toBe("hello");
    expect(peekSystemEvents("discord:group:123")).toEqual(["Discord reaction added: ✅"]);

    const discord = await prependSystemEvents({
      cfg,
      sessionKey: "discord:group:123",
      isMainSession: false,
      isNewSession: false,
      prefixedBodyBase: "hi",
    });
    expect(discord).toMatch(/^System: \[[^\]]+\] Discord reaction added: ✅\n\nhi$/);
    expect(peekSystemEvents("discord:group:123")).toEqual([]);
  });

  it("requires an explicit session key", () => {
    expect(() => enqueueSystemEvent("Node: Mac Studio", { sessionKey: " " })).toThrow("sessionKey");
  });

  it("deduplicates by source+id+hash and exposes seq-based reads", () => {
    const sessionKey = "agent:main:main";
    enqueueSystemEvent("Hook Gmail (ok): Subject A", {
      sessionKey,
      source: "email:gmail",
      sourceId: "msg-1",
    });
    enqueueSystemEvent("Hook Gmail (ok): Subject A", {
      sessionKey,
      source: "email:gmail",
      sourceId: "msg-1",
    });
    enqueueSystemEvent("Hook Gmail (ok): Subject B", {
      sessionKey,
      source: "email:gmail",
      sourceId: "msg-2",
    });

    expect(peekSystemEvents(sessionKey)).toEqual([
      "Hook Gmail (ok): Subject A",
      "Hook Gmail (ok): Subject B",
    ]);
    const latestSeq = getLatestSystemEventSeq(sessionKey);
    expect(latestSeq).toBeGreaterThan(0);
    const sinceZero = peekSystemEventEntriesSince(sessionKey, { afterSeq: 0 });
    expect(sinceZero.length).toBe(2);
    const afterFirst = peekSystemEventEntriesSince(sessionKey, {
      afterSeq: sinceZero[0]?.seq ?? 0,
    });
    expect(afterFirst.map((event) => event.text)).toEqual(["Hook Gmail (ok): Subject B"]);
  });
});
