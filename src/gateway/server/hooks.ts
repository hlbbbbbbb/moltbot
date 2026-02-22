import { randomUUID } from "node:crypto";

import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { CliDeps } from "../../cli/deps.js";
import { loadConfig } from "../../config/config.js";
import { resolveMainSessionKeyFromConfig } from "../../config/sessions.js";
import { runCronIsolatedAgentTurn } from "../../cron/isolated-agent.js";
import type { CronJob } from "../../cron/types.js";
import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import {
  ensureOutboundSessionEntry,
  resolveOutboundSessionRoute,
} from "../../infra/outbound/outbound-session.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import type { HookMessageChannel, HooksConfigResolved } from "../hooks.js";
import { createHooksRequestHandler } from "../server-http.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

export function createGatewayHooksRequestHandler(params: {
  deps: CliDeps;
  getHooksConfig: () => HooksConfigResolved | null;
  bindHost: string;
  port: number;
  logHooks: SubsystemLogger;
}) {
  const { deps, getHooksConfig, bindHost, port, logHooks } = params;

  const resolveHookEventSessionKey = async (params: {
    cfg: ReturnType<typeof loadConfig>;
    channel: HookMessageChannel;
    to?: string;
    deliver: boolean;
    mainSessionKey: string;
  }): Promise<string> => {
    const to = typeof params.to === "string" ? params.to.trim() : "";
    if (!params.deliver || params.channel === "last" || !to) return params.mainSessionKey;
    const agentId = resolveDefaultAgentId(params.cfg);
    const route = await resolveOutboundSessionRoute({
      cfg: params.cfg,
      channel: params.channel,
      agentId,
      target: to,
    });
    if (!route) return params.mainSessionKey;
    await ensureOutboundSessionEntry({
      cfg: params.cfg,
      agentId,
      channel: params.channel,
      route,
    });
    return route.sessionKey;
  };

  const dispatchWakeHook = (value: {
    text: string;
    mode: "now" | "next-heartbeat";
    eventSource?: string;
    eventId?: string;
  }) => {
    const sessionKey = resolveMainSessionKeyFromConfig();
    enqueueSystemEvent(value.text, {
      sessionKey,
      source: value.eventSource ?? "hook:wake",
      sourceId:
        typeof value.eventId === "string" && value.eventId.trim()
          ? value.eventId.trim()
          : `wake:${Date.now()}`,
    });
    if (value.mode === "now") {
      requestHeartbeatNow({ reason: "hook:wake" });
    }
  };

  const dispatchAgentHook = (value: {
    message: string;
    name: string;
    wakeMode: "now" | "next-heartbeat";
    sessionKey: string;
    deliver: boolean;
    channel: HookMessageChannel;
    to?: string;
    model?: string;
    thinking?: string;
    timeoutSeconds?: number;
    allowUnsafeExternalContent?: boolean;
    eventSource?: string;
    eventId?: string;
  }) => {
    const sessionKey = value.sessionKey.trim() ? value.sessionKey.trim() : `hook:${randomUUID()}`;
    const mainSessionKey = resolveMainSessionKeyFromConfig();
    const jobId = randomUUID();
    const now = Date.now();
    const job: CronJob = {
      id: jobId,
      name: value.name,
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "at", atMs: now },
      sessionTarget: "isolated",
      wakeMode: value.wakeMode,
      payload: {
        kind: "agentTurn",
        message: value.message,
        model: value.model,
        thinking: value.thinking,
        timeoutSeconds: value.timeoutSeconds,
        deliver: value.deliver,
        channel: value.channel,
        to: value.to,
        allowUnsafeExternalContent: value.allowUnsafeExternalContent,
      },
      state: { nextRunAtMs: now },
    };

    const runId = randomUUID();
    void (async () => {
      let eventSessionKey = mainSessionKey;
      try {
        const cfg = loadConfig();
        try {
          eventSessionKey = await resolveHookEventSessionKey({
            cfg,
            channel: value.channel,
            to: value.to,
            deliver: value.deliver,
            mainSessionKey,
          });
        } catch (err) {
          logHooks.warn(`hook event session routing failed: ${String(err)}`);
          eventSessionKey = mainSessionKey;
        }
        const result = await runCronIsolatedAgentTurn({
          cfg,
          deps,
          job,
          message: value.message,
          sessionKey,
          lane: "cron",
        });
        const summary = result.summary?.trim() || result.error?.trim() || result.status;
        const prefix =
          result.status === "ok" ? `Hook ${value.name}` : `Hook ${value.name} (${result.status})`;
        enqueueSystemEvent(`${prefix}: ${summary}`.trim(), {
          sessionKey: eventSessionKey,
          source: value.eventSource ?? "hook:agent",
          sourceId:
            typeof value.eventId === "string" && value.eventId.trim()
              ? value.eventId.trim()
              : `${sessionKey}:${jobId}`,
          metadata: {
            hookName: value.name,
            hookStatus: result.status,
          },
        });
        if (value.wakeMode === "now" && eventSessionKey === mainSessionKey) {
          requestHeartbeatNow({ reason: `hook:${jobId}` });
        }
      } catch (err) {
        logHooks.warn(`hook agent failed: ${String(err)}`);
        enqueueSystemEvent(`Hook ${value.name} (error): ${String(err)}`, {
          sessionKey: eventSessionKey,
          source: value.eventSource ?? "hook:agent",
          sourceId:
            typeof value.eventId === "string" && value.eventId.trim()
              ? value.eventId.trim()
              : `${sessionKey}:${jobId}`,
          metadata: {
            hookName: value.name,
            hookStatus: "error",
          },
        });
        if (value.wakeMode === "now" && eventSessionKey === mainSessionKey) {
          requestHeartbeatNow({ reason: `hook:${jobId}:error` });
        }
      }
    })();

    return runId;
  };

  return createHooksRequestHandler({
    getHooksConfig,
    bindHost,
    port,
    logHooks,
    dispatchAgentHook,
    dispatchWakeHook,
  });
}
