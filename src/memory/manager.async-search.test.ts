import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";

const embedBatch = vi.fn(async () => []);
const embedQuery = vi.fn(async () => [0.2, 0.2, 0.2]);

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "openai",
      model: "text-embedding-3-small",
      embedQuery,
      embedBatch,
    },
    openAi: {
      baseUrl: "https://api.openai.com/v1",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      model: "text-embedding-3-small",
    },
  }),
}));

describe("memory search async sync", () => {
  let workspaceDir: string;
  let indexPath: string;
  let manager: MemoryIndexManager | null = null;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-mem-async-"));
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"));
    await fs.writeFile(path.join(workspaceDir, "memory", "2026-01-07.md"), "hello\n");
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (manager) {
      await manager.close();
      manager = null;
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("does not await sync when searching", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
            store: { path: indexPath },
            sync: { watch: false, onSessionStart: false, onSearch: true },
            query: { minScore: 0 },
            remote: { batch: { enabled: true, wait: true } },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };

    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) throw new Error("manager missing");
    manager = result.manager;

    const pending = new Promise<void>(() => {});
    (manager as unknown as { sync: () => Promise<void> }).sync = vi.fn(async () => pending);

    const resolved = await Promise.race([
      manager.search("hello").then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
    ]);
    expect(resolved).toBe(true);
  });

  it("returns immediately from sync after close", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
            store: { path: indexPath },
            sync: { watch: false, onSessionStart: false, onSearch: false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };

    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) throw new Error("manager missing");
    manager = result.manager;

    await manager.close();
    const runSyncSpy = vi.fn(async () => undefined);
    (manager as unknown as { runSync: typeof runSyncSpy }).runSync = runSyncSpy;

    await (manager as unknown as { sync: (params?: unknown) => Promise<void> }).sync({
      reason: "after-close",
    });

    expect(runSyncSpy).not.toHaveBeenCalled();
  });

  it("waits for in-flight sync before close resolves", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
            store: { path: indexPath },
            sync: { watch: false, onSessionStart: false, onSearch: false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };

    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) throw new Error("manager missing");
    manager = result.manager;

    let releaseSync: (() => void) | undefined;
    const syncBlock = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const runSyncSpy = vi.fn(async () => await syncBlock);
    (manager as unknown as { runSync: typeof runSyncSpy }).runSync = runSyncSpy;

    const syncPromise = (manager as unknown as { sync: (params?: unknown) => Promise<void> }).sync({
      reason: "manual",
    });

    await Promise.resolve();

    let closeResolved = false;
    const closePromise = manager.close().then(() => {
      closeResolved = true;
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(closeResolved).toBe(false);

    releaseSync?.();

    await syncPromise;
    await closePromise;
    expect(closeResolved).toBe(true);
  });
});
