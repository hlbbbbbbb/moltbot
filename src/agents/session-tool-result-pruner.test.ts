import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pruneSessionFileToolResults } from "./session-tool-result-pruner.js";

// ---------------------------------------------------------------------------
// Helpers — build .jsonl entries matching the SessionManager format
// ---------------------------------------------------------------------------

let idCounter = 0;
let parentId: string | null = null;

function resetIds() {
  idCounter = 0;
  parentId = null;
}

function nextId(): string {
  return `entry-${++idCounter}`;
}

function makeSessionHeader(): Record<string, unknown> {
  nextId(); // advance counter
  parentId = null;
  return {
    type: "session",
    version: 3,
    id: "session-test",
    timestamp: new Date().toISOString(),
    cwd: "/tmp/test",
  };
}

function makeUserEntry(text: string): Record<string, unknown> {
  const id = nextId();
  const entry = {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: {
      role: "user",
      content: text,
      timestamp: Date.now(),
    },
  };
  parentId = id;
  return entry;
}

function makeAssistantEntry(text: string): Record<string, unknown> {
  const id = nextId();
  const entry = {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  };
  parentId = id;
  return entry;
}

function makeToolResultEntry(params: {
  toolCallId: string;
  toolName: string;
  text: string;
}): Record<string, unknown> {
  const id = nextId();
  const entry = {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: {
      role: "toolResult",
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      content: [{ type: "text", text: params.text }],
      isError: false,
      timestamp: Date.now(),
    },
  };
  parentId = id;
  return entry;
}

function makeImageToolResultEntry(params: {
  toolCallId: string;
  toolName: string;
  text: string;
}): Record<string, unknown> {
  const id = nextId();
  const entry = {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: {
      role: "toolResult",
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      content: [
        { type: "image", data: "AA==", mimeType: "image/png" },
        { type: "text", text: params.text },
      ],
      isError: false,
      timestamp: Date.now(),
    },
  };
  parentId = id;
  return entry;
}

function bigText(chars: number): string {
  return "x".repeat(chars);
}

function writeSession(filePath: string, entries: Record<string, unknown>[]): void {
  const lines = entries.map((e) => JSON.stringify(e));
  fs.writeFileSync(filePath, lines.join("\n") + "\n");
}

function readEntries(filePath: string): Record<string, unknown>[] {
  const content = fs.readFileSync(filePath, "utf8").trim();
  return content.split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
}

function getToolResultText(entry: Record<string, unknown>): string {
  const msg = entry.message as Record<string, unknown>;
  const content = msg.content as Array<{ type: string; text?: string }>;
  const textBlock = content.find((b) => b.type === "text");
  return textBlock?.text ?? "";
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("session-tool-result-pruner", () => {
  let tmpDir: string;
  let sessionFile: string;

  beforeEach(() => {
    resetIds();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pruner-test-"));
    sessionFile = path.join(tmpDir, "test-session.jsonl");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("replaces old tool results with placeholders", () => {
    const entries = [
      makeSessionHeader(),
      makeUserEntry("hello"),
      makeAssistantEntry("let me check"),
      makeToolResultEntry({ toolCallId: "tc1", toolName: "exec", text: bigText(1000) }),
      makeAssistantEntry("found some results"),
      // 4 more assistant turns to push tc1 beyond keepLastAssistants=3
      makeUserEntry("next"),
      makeAssistantEntry("reply 2"),
      makeUserEntry("more"),
      makeAssistantEntry("reply 3"),
      makeUserEntry("again"),
      makeAssistantEntry("reply 4"),
    ];
    writeSession(sessionFile, entries);

    const replaced = pruneSessionFileToolResults(sessionFile, { keepLastAssistants: 3 });

    expect(replaced).toBe(1);
    const result = readEntries(sessionFile);
    const toolEntry = result.find(
      (e) => (e.message as Record<string, unknown>)?.role === "toolResult",
    );
    expect(toolEntry).toBeDefined();
    const text = getToolResultText(toolEntry!);
    expect(text).toContain("[Tool result from exec:");
    expect(text).toContain("1000 chars");
    expect(text).not.toContain("x".repeat(100));
  });

  it("preserves tool results within keepLastAssistants window", () => {
    const entries = [
      makeSessionHeader(),
      makeUserEntry("hello"),
      makeAssistantEntry("checking"),
      makeToolResultEntry({ toolCallId: "tc1", toolName: "exec", text: bigText(2000) }),
      makeAssistantEntry("found it"),
      makeUserEntry("ok"),
      makeAssistantEntry("done"),
    ];
    writeSession(sessionFile, entries);

    // With keepLastAssistants=3, we have exactly 3 assistants, so nothing is old enough
    const replaced = pruneSessionFileToolResults(sessionFile, { keepLastAssistants: 3 });
    expect(replaced).toBe(0);
  });

  it("skips bootstrap tool results before first user message", () => {
    const entries = [
      makeSessionHeader(),
      // Bootstrap reads happen before first user message
      makeToolResultEntry({ toolCallId: "tc-boot", toolName: "read", text: bigText(5000) }),
      makeAssistantEntry("identity loaded"),
      makeUserEntry("hello"),
      makeAssistantEntry("hi"),
      makeUserEntry("next"),
      makeAssistantEntry("ok"),
      makeUserEntry("more"),
      makeAssistantEntry("sure"),
      makeUserEntry("again"),
      makeAssistantEntry("yep"),
    ];
    writeSession(sessionFile, entries);

    const replaced = pruneSessionFileToolResults(sessionFile, { keepLastAssistants: 3 });
    expect(replaced).toBe(0);

    // Verify the bootstrap result is untouched
    const result = readEntries(sessionFile);
    const bootEntry = result.find(
      (e) =>
        (e.message as Record<string, unknown>)?.role === "toolResult" &&
        (e.message as Record<string, unknown>)?.toolCallId === "tc-boot",
    );
    expect(bootEntry).toBeDefined();
    expect(getToolResultText(bootEntry!)).toBe(bigText(5000));
  });

  it("skips image-containing tool results", () => {
    const entries = [
      makeSessionHeader(),
      makeUserEntry("take a screenshot"),
      makeAssistantEntry("taking screenshot"),
      makeImageToolResultEntry({
        toolCallId: "tc-img",
        toolName: "screenshot",
        text: bigText(3000),
      }),
      makeAssistantEntry("here is the screenshot"),
      // Push past keepLastAssistants
      makeUserEntry("next"),
      makeAssistantEntry("reply 2"),
      makeUserEntry("more"),
      makeAssistantEntry("reply 3"),
      makeUserEntry("again"),
      makeAssistantEntry("reply 4"),
    ];
    writeSession(sessionFile, entries);

    const replaced = pruneSessionFileToolResults(sessionFile, { keepLastAssistants: 3 });
    expect(replaced).toBe(0);
  });

  it("skips small tool results below threshold", () => {
    const entries = [
      makeSessionHeader(),
      makeUserEntry("hello"),
      makeAssistantEntry("checking"),
      makeToolResultEntry({ toolCallId: "tc1", toolName: "exec", text: "small output" }),
      makeAssistantEntry("done"),
      makeUserEntry("next"),
      makeAssistantEntry("reply 2"),
      makeUserEntry("more"),
      makeAssistantEntry("reply 3"),
      makeUserEntry("again"),
      makeAssistantEntry("reply 4"),
    ];
    writeSession(sessionFile, entries);

    const replaced = pruneSessionFileToolResults(sessionFile, {
      keepLastAssistants: 3,
      minCharsToReplace: 500,
    });
    expect(replaced).toBe(0);
  });

  it("is idempotent — skips already-replaced results", () => {
    const entries = [
      makeSessionHeader(),
      makeUserEntry("hello"),
      makeAssistantEntry("checking"),
      makeToolResultEntry({ toolCallId: "tc1", toolName: "exec", text: bigText(2000) }),
      makeAssistantEntry("done"),
      makeUserEntry("a"),
      makeAssistantEntry("b"),
      makeUserEntry("c"),
      makeAssistantEntry("d"),
      makeUserEntry("e"),
      makeAssistantEntry("f"),
    ];
    writeSession(sessionFile, entries);

    const replaced1 = pruneSessionFileToolResults(sessionFile, { keepLastAssistants: 3 });
    expect(replaced1).toBe(1);

    // Run again — should not replace anything
    const replaced2 = pruneSessionFileToolResults(sessionFile, { keepLastAssistants: 3 });
    expect(replaced2).toBe(0);
  });

  it("preserves .jsonl structure and entry metadata", () => {
    const entries = [
      makeSessionHeader(),
      makeUserEntry("hello"),
      makeAssistantEntry("checking"),
      makeToolResultEntry({ toolCallId: "tc1", toolName: "exec", text: bigText(2000) }),
      makeAssistantEntry("done"),
      makeUserEntry("a"),
      makeAssistantEntry("b"),
      makeUserEntry("c"),
      makeAssistantEntry("d"),
      makeUserEntry("e"),
      makeAssistantEntry("f"),
    ];
    writeSession(sessionFile, entries);

    pruneSessionFileToolResults(sessionFile, { keepLastAssistants: 3 });

    const result = readEntries(sessionFile);

    // Same number of entries
    expect(result.length).toBe(entries.length);

    // Header preserved
    expect(result[0].type).toBe("session");

    // All message entries still have id/parentId/timestamp
    for (const entry of result) {
      if (entry.type === "message") {
        expect(entry.id).toBeDefined();
        expect(entry.timestamp).toBeDefined();
        expect((entry.message as Record<string, unknown>).role).toBeDefined();
      }
    }

    // The replaced tool result preserves toolCallId
    const toolEntry = result.find(
      (e) => (e.message as Record<string, unknown>)?.role === "toolResult",
    );
    expect((toolEntry!.message as Record<string, unknown>).toolCallId).toBe("tc1");
    expect((toolEntry!.message as Record<string, unknown>).toolName).toBe("exec");
  });

  it("handles multiple tool results in a single turn", () => {
    const entries = [
      makeSessionHeader(),
      makeUserEntry("check everything"),
      makeAssistantEntry("running tools"),
      makeToolResultEntry({ toolCallId: "tc1", toolName: "exec", text: bigText(3000) }),
      makeToolResultEntry({ toolCallId: "tc2", toolName: "read", text: bigText(4000) }),
      makeToolResultEntry({ toolCallId: "tc3", toolName: "browser", text: bigText(5000) }),
      makeAssistantEntry("found 3 things"),
      // Push past keepLastAssistants=3
      makeUserEntry("a"),
      makeAssistantEntry("b"),
      makeUserEntry("c"),
      makeAssistantEntry("d"),
      makeUserEntry("e"),
      makeAssistantEntry("f"),
    ];
    writeSession(sessionFile, entries);

    const replaced = pruneSessionFileToolResults(sessionFile, { keepLastAssistants: 3 });
    expect(replaced).toBe(3);

    const result = readEntries(sessionFile);
    const toolEntries = result.filter(
      (e) => (e.message as Record<string, unknown>)?.role === "toolResult",
    );
    for (const te of toolEntries) {
      expect(getToolResultText(te)).toContain("[Tool result from ");
    }
  });

  it("returns 0 for empty session file", () => {
    fs.writeFileSync(sessionFile, "");
    expect(pruneSessionFileToolResults(sessionFile)).toBe(0);
  });

  it("returns 0 for nonexistent file", () => {
    expect(pruneSessionFileToolResults("/nonexistent/file.jsonl")).toBe(0);
  });

  it("returns 0 for session with no tool results", () => {
    const entries = [
      makeSessionHeader(),
      makeUserEntry("hello"),
      makeAssistantEntry("hi"),
      makeUserEntry("bye"),
      makeAssistantEntry("goodbye"),
    ];
    writeSession(sessionFile, entries);

    expect(pruneSessionFileToolResults(sessionFile)).toBe(0);
  });

  it("respects custom keepLastAssistants value", () => {
    const entries = [
      makeSessionHeader(),
      makeUserEntry("hello"),
      makeAssistantEntry("checking"),
      makeToolResultEntry({ toolCallId: "tc1", toolName: "exec", text: bigText(2000) }),
      makeAssistantEntry("found it"),
      makeUserEntry("next"),
      makeAssistantEntry("reply 2"),
    ];
    writeSession(sessionFile, entries);

    // With keepLastAssistants=1, only 1 assistant is protected.
    // We have 3 assistants, cutoff is at assistant index [3-1=2] which is "reply 2" (index 2).
    // tc1's tool result is before that cutoff → should be replaced
    const replaced = pruneSessionFileToolResults(sessionFile, { keepLastAssistants: 1 });
    expect(replaced).toBe(1);
  });

  it("significantly reduces file size for realistic session", () => {
    const entries: Record<string, unknown>[] = [makeSessionHeader()];

    // Simulate 10 turns with large tool results
    for (let i = 0; i < 10; i++) {
      entries.push(makeUserEntry(`question ${i}`));
      entries.push(makeAssistantEntry("running tool"));
      entries.push(
        makeToolResultEntry({
          toolCallId: `tc${i}`,
          toolName: "exec",
          text: bigText(50_000), // 50k chars each
        }),
      );
      entries.push(makeAssistantEntry(`answer ${i}: found some results`));
    }

    writeSession(sessionFile, entries);
    const sizeBefore = fs.statSync(sessionFile).size;

    const replaced = pruneSessionFileToolResults(sessionFile, { keepLastAssistants: 3 });

    const sizeAfter = fs.statSync(sessionFile).size;

    // 7 out of 10 tool results should be replaced (10 - 3 protected)
    // But the cutoff is at the 7th assistant (10 - 3 = 7th from end)
    // Each turn has 2 assistants ("running tool" + "answer"), so we have 20 assistants total
    // keepLast=3 means cutoff at 17th assistant. Tool results before that get replaced.
    expect(replaced).toBeGreaterThanOrEqual(7);
    expect(sizeAfter).toBeLessThan(sizeBefore * 0.15); // At least 85% reduction
  });
});
