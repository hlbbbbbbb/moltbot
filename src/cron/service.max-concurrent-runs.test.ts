import { describe, expect, it, vi } from "vitest";

import { runDueJobs } from "./service/timer.js";
import { createCronServiceState } from "./service/state.js";
import type { CronJob } from "./types.js";

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeDueIsolatedJob(id: string): CronJob {
  return {
    id,
    name: `job-${id}`,
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: 0 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "run" },
    state: { nextRunAtMs: 1 },
  };
}

describe("cron timer concurrency", () => {
  it("honors maxConcurrentRuns when executing due jobs", async () => {
    const releaseGates: Array<() => void> = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const runIsolatedAgentJob = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => {
        releaseGates.push(() => {
          inFlight -= 1;
          resolve();
        });
      });
      return { status: "ok" as const, summary: "ok" };
    });

    const state = createCronServiceState({
      nowMs: () => 10,
      log: noopLogger,
      storePath: "/tmp/clawdbot-cron-concurrency-test.json",
      cronEnabled: true,
      maxConcurrentRuns: 2,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
    });

    state.store = {
      version: 1,
      jobs: [makeDueIsolatedJob("1"), makeDueIsolatedJob("2"), makeDueIsolatedJob("3")],
    };

    const pending = runDueJobs(state);

    await vi.waitFor(() => {
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
    });
    expect(maxInFlight).toBe(2);

    const firstRelease = releaseGates.shift();
    firstRelease?.();

    await vi.waitFor(() => {
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(3);
    });
    expect(maxInFlight).toBe(2);

    while (releaseGates.length > 0) {
      const release = releaseGates.shift();
      release?.();
    }

    await pending;
    expect(maxInFlight).toBe(2);
  });
});
