import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ClawdbotConfig } from "../config/config.js";
import {
  buildDefaultImapHookUrl,
  extractHimalayaEnvelopes,
  runImapPoll,
  resolveImapPollRuntimeConfig,
  type ImapPollOptions,
} from "./imap-poller.js";

describe("imap poller", () => {
  it("builds a default /hooks/imap URL", () => {
    const url = buildDefaultImapHookUrl("/hooks", 18789);
    expect(url).toBe("http://127.0.0.1:18789/hooks/imap");
  });

  it("resolves runtime config and allows dry-run without hook token", () => {
    const cfg = {} as ClawdbotConfig;
    const result = resolveImapPollRuntimeConfig(cfg, {
      account: "qq",
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.account).toBe("qq");
    expect(result.value.dryRun).toBe(true);
    expect(result.value.hookToken).toBeUndefined();
  });

  it("normalizes himalaya envelope payloads", () => {
    const envelopes = extractHimalayaEnvelopes({
      messages: [
        {
          id: 42,
          subject: "Meeting",
          from: [{ name: "Ada", addr: "ada@example.com" }],
          date: "2026-02-11T10:00:00Z",
          snippet: "Let's sync",
        },
      ],
    });

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toEqual(
      expect.objectContaining({
        id: "42",
        key: "id:42",
        from: "Ada <ada@example.com>",
        subject: "Meeting",
        snippet: "Let's sync",
      }),
    );
  });

  it("bootstraps on first run, then sends only newly seen emails", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-imap-poller-"));
    const stateFile = path.join(tmpDir, "state.json");

    let envelopeList = [
      { id: 2, subject: "Old 2", from: "legacy@example.com" },
      { id: 1, subject: "Old 1", from: "legacy@example.com" },
    ];

    const runCommand = vi.fn(async (argv: string[]) => {
      if (argv.includes("envelope") && argv.includes("list")) {
        return {
          stdout: JSON.stringify(envelopeList),
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
        };
      }
      if (argv.includes("message") && argv.includes("read")) {
        return {
          stdout: "Body",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
        };
      }
      throw new Error(`unexpected argv: ${argv.join(" ")}`);
    });

    const postHook = vi.fn(async () => {});

    const baseOpts: ImapPollOptions = {
      account: "qq",
      stateFile,
      hookUrl: "http://127.0.0.1:18789/hooks/imap",
      hookToken: "hook-token",
      config: {} as ClawdbotConfig,
    };

    const now = () => new Date("2026-02-11T10:00:00Z");

    const first = await runImapPoll(baseOpts, {
      runCommand,
      postHook,
      now,
    });

    expect(first.status).toBe("bootstrapped");
    expect(first.newMessages).toBe(0);
    expect(postHook).not.toHaveBeenCalled();

    const second = await runImapPoll(baseOpts, {
      runCommand,
      postHook,
      now,
    });

    expect(second.status).toBe("idle");
    expect(second.newMessages).toBe(0);
    expect(postHook).not.toHaveBeenCalled();

    envelopeList = [
      { id: 3, subject: "Fresh", from: "new@example.com", snippet: "new mail" },
      ...envelopeList,
    ];

    const third = await runImapPoll(baseOpts, {
      runCommand,
      postHook,
      now,
    });

    expect(third.status).toBe("sent");
    expect(third.newMessages).toBe(1);
    expect(postHook).toHaveBeenCalledTimes(1);

    const sentPayload = postHook.mock.calls[0]?.[0]?.payload as
      | { messages?: Array<{ key?: string; subject?: string }> }
      | undefined;
    expect(sentPayload?.messages?.[0]?.key).toBe("id:3");
    expect(sentPayload?.messages?.[0]?.subject).toBe("Fresh");

    const storedRaw = await fs.readFile(stateFile, "utf8");
    const stored = JSON.parse(storedRaw) as { seen?: string[] };
    expect(stored.seen).toContain("id:3");
  });

  it("does not mark unsent backlog as seen when maxMessages limits delivery", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-imap-limit-"));
    const stateFile = path.join(tmpDir, "state.json");

    const envelopeList = [
      { id: 3, subject: "Mail 3", from: "a@example.com" },
      { id: 2, subject: "Mail 2", from: "b@example.com" },
      { id: 1, subject: "Mail 1", from: "c@example.com" },
    ];

    const runCommand = vi.fn(async (argv: string[]) => {
      if (argv.includes("envelope") && argv.includes("list")) {
        return {
          stdout: JSON.stringify(envelopeList),
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
        };
      }
      if (argv.includes("message") && argv.includes("read")) {
        return {
          stdout: "Body",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
        };
      }
      throw new Error(`unexpected argv: ${argv.join(" ")}`);
    });

    const postHook = vi.fn(async () => {});
    const opts: ImapPollOptions = {
      account: "qq",
      stateFile,
      hookUrl: "http://127.0.0.1:18789/hooks/imap",
      hookToken: "hook-token",
      maxMessages: 1,
      bootstrap: false,
      config: {} as ClawdbotConfig,
    };

    await runImapPoll(opts, { runCommand, postHook });
    const firstPayload = postHook.mock.calls[0]?.[0]?.payload as
      | { messages?: Array<{ key?: string }> }
      | undefined;
    expect(firstPayload?.messages?.[0]?.key).toBe("id:3");

    const firstState = JSON.parse(await fs.readFile(stateFile, "utf8")) as { seen?: string[] };
    expect(firstState.seen).toEqual(["id:3"]);

    await runImapPoll(opts, { runCommand, postHook });
    const secondPayload = postHook.mock.calls[1]?.[0]?.payload as
      | { messages?: Array<{ key?: string }> }
      | undefined;
    expect(secondPayload?.messages?.[0]?.key).toBe("id:2");

    const secondState = JSON.parse(await fs.readFile(stateFile, "utf8")) as { seen?: string[] };
    expect(secondState.seen).toEqual(["id:3", "id:2"]);
    expect(secondState.seen).not.toContain("id:1");
  });

  it("treats known QQ IMAP sequence errors as empty mailbox", async () => {
    const runCommand = vi.fn(async () => ({
      stdout: "",
      stderr: "unexpected BAD response: Sequence set is inavlid!",
      code: 1,
      signal: null,
      killed: false,
    }));

    const postHook = vi.fn(async () => {});
    const result = await runImapPoll(
      {
        account: "qq",
        hookUrl: "http://127.0.0.1:18789/hooks/imap",
        hookToken: "hook-token",
        bootstrap: false,
        stateFile: path.join(
          await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-imap-empty-")),
          "state.json",
        ),
        config: {} as ClawdbotConfig,
      },
      { runCommand, postHook },
    );

    expect(result.status).toBe("idle");
    expect(result.newMessages).toBe(0);
    expect(postHook).not.toHaveBeenCalled();
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it("retries with page-size=1 when QQ list fails with sequence error", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-imap-qq-retry-"));
    const stateFile = path.join(tmpDir, "state.json");

    const runCommand = vi.fn(async (argv: string[]) => {
      const pageSizeIndex = argv.indexOf("--page-size");
      const pageSize = pageSizeIndex >= 0 ? argv[pageSizeIndex + 1] : "";
      if (pageSize === "50") {
        return {
          stdout: "",
          stderr: "unexpected BAD response: Sequence set is inavlid!",
          code: 1,
          signal: null,
          killed: false,
        };
      }
      if (pageSize === "1") {
        return {
          stdout: JSON.stringify([
            {
              id: 3338,
              subject: "qq mail",
              from: { name: "QQ", addr: "10000@qq.com" },
            },
          ]),
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected page-size: ${pageSize}`,
        code: 1,
        signal: null,
        killed: false,
      };
    });

    const postHook = vi.fn(async () => {});
    const result = await runImapPoll(
      {
        account: "qq",
        hookUrl: "http://127.0.0.1:18789/hooks/imap",
        hookToken: "hook-token",
        bootstrap: false,
        stateFile,
        config: {} as ClawdbotConfig,
      },
      { runCommand, postHook },
    );

    expect(result.status).toBe("sent");
    expect(result.newMessages).toBe(1);
    expect(postHook).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it("recovers skipped invalid fetch envelopes from QQ logs", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-imap-qq-invalid-fetch-"));
    const stateFile = path.join(tmpDir, "state.json");

    const runCommand = vi.fn(async (argv: string[]) => {
      if (argv.includes("envelope") && argv.includes("list")) {
        const pageSizeIndex = argv.indexOf("--page-size");
        const pageSize = pageSizeIndex >= 0 ? argv[pageSizeIndex + 1] : "";
        if (pageSize === "50") {
          return {
            stdout: "",
            stderr: "unexpected BAD response: Sequence set is inavlid!",
            code: 1,
            signal: null,
            killed: false,
          };
        }
        if (pageSize === "1") {
          return {
            stdout: "[]",
            stderr:
              'WARN imap_client::tasks: skipping invalid fetch fetch="* 3329 FETCH (UID 3339 FLAGS () ENVELOPE (\\"Wed, 11 Feb 2026 09:18:46 -0800\\" \\"Subject\\" ...))"',
            code: 0,
            signal: null,
            killed: false,
          };
        }
      }

      if (argv.includes("message") && argv.includes("read") && argv[3] === "3339") {
        return {
          stdout: [
            "From: huanglaobanbanban@gmail.com",
            "To: 1653120857@qq.com",
            "Subject: E2E-GMAIL-TO-QQ-1770830322",
            "Message-ID: <test-3339@example.com>",
            "",
            "Body from recovered invalid fetch.",
          ].join("\n"),
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
        };
      }

      return {
        stdout: "",
        stderr: `unexpected argv: ${argv.join(" ")}`,
        code: 1,
        signal: null,
        killed: false,
      };
    });

    const postHook = vi.fn(async () => {});
    const result = await runImapPoll(
      {
        account: "qq",
        hookUrl: "http://127.0.0.1:18789/hooks/imap",
        hookToken: "hook-token",
        bootstrap: false,
        stateFile,
        config: {} as ClawdbotConfig,
      },
      { runCommand, postHook },
    );

    expect(result.status).toBe("sent");
    expect(result.newMessages).toBe(1);
    expect(postHook).toHaveBeenCalledTimes(1);

    const sentPayload = postHook.mock.calls[0]?.[0]?.payload as
      | { messages?: Array<{ id?: string; key?: string; subject?: string; from?: string }> }
      | undefined;
    expect(sentPayload?.messages?.[0]).toEqual(
      expect.objectContaining({
        id: "3339",
        key: "mid:<test-3339@example.com>",
        subject: "E2E-GMAIL-TO-QQ-1770830322",
        from: "huanglaobanbanban@gmail.com",
      }),
    );
    expect(runCommand).toHaveBeenCalledTimes(3);
  });
});
