import fs from "node:fs";

import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentModelFallbacksOverride,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { runCliAgent } from "../../agents/cli-runner.js";
import { getCliSessionId, setCliSessionId } from "../../agents/cli-session.js";
import { lookupContextTokens } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { loadModelCatalog } from "../../agents/model-catalog.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import {
  getModelRefStatus,
  isCliProvider,
  resolveAllowedModelRef,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
  resolveThinkingDefault,
} from "../../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import type { MessagingToolSend } from "../../agents/pi-embedded-messaging.js";
import { buildWorkspaceSkillSnapshot } from "../../agents/skills.js";
import { getSkillsSnapshotVersion } from "../../agents/skills/refresh.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { hasNonzeroUsage } from "../../agents/usage.js";
import { ensureAgentWorkspace } from "../../agents/workspace.js";
import {
  formatUserTime,
  resolveUserTimeFormat,
  resolveUserTimezone,
} from "../../agents/date-time.js";
import {
  formatXHighModelHint,
  normalizeThinkLevel,
  normalizeVerboseLevel,
  supportsXHighThinking,
} from "../../auto-reply/thinking.js";
import { createOutboundSendDeps, type CliDeps } from "../../cli/outbound-send-deps.js";
import type { ClawdbotConfig } from "../../config/config.js";
import {
  loadSessionStore,
  resolveAgentMainSessionKey,
  resolveSessionFilePath,
  resolveStorePath,
  updateSessionStore,
} from "../../config/sessions.js";
import type { AgentDefaultsConfig } from "../../config/types.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import {
  ensureOutboundSessionEntry,
  resolveOutboundSessionRoute,
} from "../../infra/outbound/outbound-session.js";
import { getRemoteSkillEligibility } from "../../infra/skills-remote.js";
import { buildAgentMainSessionKey, normalizeAgentId } from "../../routing/session-key.js";
import {
  buildSafeExternalPrompt,
  detectSuspiciousPatterns,
  getHookType,
  isExternalHookSession,
} from "../../security/external-content.js";
import { logWarn } from "../../logger.js";
import type { CronJob } from "../types.js";
import { resolveDeliveryTarget } from "./delivery-target.js";
import {
  isHeartbeatOnlyResponse,
  pickLastNonEmptyTextFromPayloads,
  pickSummaryFromOutput,
  pickSummaryFromPayloads,
  resolveHeartbeatAckMaxChars,
} from "./helpers.js";
import { resolveCronSession } from "./session.js";

const MAIN_CONTEXT_HEADER = "[Main session recent context]";
const MAIN_CONTEXT_MAX_MESSAGES = 8;
const MAIN_CONTEXT_MAX_CHARS_PER_LINE = 220;
const MAIN_CONTEXT_MAX_CHARS_TOTAL = 1200;
const MAIN_CONTEXT_READ_BYTES = 256 * 1024;

type TranscriptRole = "user" | "assistant";

function normalizeContextText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function truncateContextText(raw: string, maxChars: number): string {
  if (raw.length <= maxChars) return raw;
  if (maxChars <= 3) return raw.slice(0, maxChars);
  return `${raw.slice(0, maxChars - 3).trimEnd()}...`;
}

function extractTranscriptText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const pieces: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const type = (item as { type?: unknown }).type;
    if (typeof type === "string") {
      const normalizedType = type.trim().toLowerCase();
      if (
        normalizedType !== "text" &&
        normalizedType !== "input_text" &&
        normalizedType !== "output_text"
      ) {
        continue;
      }
    }
    const text = (item as { text?: unknown }).text;
    if (typeof text === "string" && text.trim()) {
      pieces.push(text);
    }
  }
  return pieces.join(" ");
}

function parseTranscriptMessage(
  rawMessage: unknown,
): { role: TranscriptRole; text: string } | null {
  if (!rawMessage || typeof rawMessage !== "object") return null;
  const role = (rawMessage as { role?: unknown }).role;
  if (role !== "user" && role !== "assistant") return null;
  const content = (rawMessage as { content?: unknown }).content;
  const text = normalizeContextText(extractTranscriptText(content));
  if (!text) return null;
  return { role, text };
}

function readRecentMainSessionContext(params: { cfg: ClawdbotConfig; agentId: string }): string[] {
  try {
    const mainSessionKey = resolveAgentMainSessionKey({
      cfg: params.cfg,
      agentId: params.agentId,
    });
    const storePath = resolveStorePath(params.cfg.session?.store, {
      agentId: params.agentId,
    });
    const store = loadSessionStore(storePath);
    const mainEntry = store[mainSessionKey];
    if (!mainEntry?.sessionId) return [];

    const transcriptPath = resolveSessionFilePath(mainEntry.sessionId, mainEntry, {
      agentId: params.agentId,
    });
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];

    const stat = fs.statSync(transcriptPath);
    if (!stat.isFile() || stat.size <= 0) return [];

    const readBytes = Math.min(stat.size, MAIN_CONTEXT_READ_BYTES);
    const start = Math.max(0, stat.size - readBytes);
    const buffer = Buffer.alloc(readBytes);
    const fd = fs.openSync(transcriptPath, "r");
    try {
      fs.readSync(fd, buffer, 0, readBytes, start);
    } finally {
      fs.closeSync(fd);
    }

    const lines = buffer
      .toString("utf-8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);

    const contextLines: string[] = [];
    let totalChars = 0;
    for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
      if (contextLines.length >= MAIN_CONTEXT_MAX_MESSAGES) break;
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[idx]);
      } catch {
        continue;
      }
      const message = (parsed as { message?: unknown } | null)?.message;
      const entry = parseTranscriptMessage(message);
      if (!entry) continue;
      const label = entry.role === "user" ? "User" : "Assistant";
      const text = truncateContextText(entry.text, MAIN_CONTEXT_MAX_CHARS_PER_LINE);
      const line = `- ${label}: ${text}`;
      totalChars += line.length;
      if (totalChars > MAIN_CONTEXT_MAX_CHARS_TOTAL) break;
      contextLines.push(line);
    }

    return contextLines.reverse();
  } catch {
    return [];
  }
}

function matchesMessagingToolDeliveryTarget(
  target: MessagingToolSend,
  delivery: { channel: string; to?: string; accountId?: string },
): boolean {
  if (!delivery.to || !target.to) return false;
  const channel = delivery.channel.trim().toLowerCase();
  const provider = target.provider?.trim().toLowerCase();
  if (provider && provider !== "message" && provider !== channel) return false;
  if (target.accountId && delivery.accountId && target.accountId !== delivery.accountId) {
    return false;
  }
  return target.to === delivery.to;
}

function normalizeErrorText(err: unknown): string {
  if (err instanceof Error && err.message.trim()) {
    return err.message;
  }
  return String(err);
}

function extractHttpStatus(err: unknown): number | undefined {
  const maybeStatus = (err as { response?: { status?: unknown } } | null)?.response?.status;
  if (typeof maybeStatus === "number" && Number.isFinite(maybeStatus)) {
    return maybeStatus;
  }
  return undefined;
}

function isNonRetryableDeliveryError(err: unknown, errorText?: string): boolean {
  const status = extractHttpStatus(err);
  if (status === 400 || status === 404) {
    return true;
  }

  const text = (errorText ?? normalizeErrorText(err)).toLowerCase();
  if (!text) return false;

  return (
    text.includes("requires a recipient") ||
    text.includes("invalid receive_id") ||
    text.includes("receive_id") ||
    text.includes("invalid target") ||
    text.includes("unsupported channel") ||
    text.includes("status code 400") ||
    text.includes("230001")
  );
}

export type RunCronAgentTurnResult = {
  status: "ok" | "error" | "skipped";
  summary?: string;
  /** Last non-empty agent text output (not truncated). */
  outputText?: string;
  error?: string;
  nonRetryable?: boolean;
};

export async function runCronIsolatedAgentTurn(params: {
  cfg: ClawdbotConfig;
  deps: CliDeps;
  job: CronJob;
  message: string;
  sessionKey: string;
  agentId?: string;
  lane?: string;
}): Promise<RunCronAgentTurnResult> {
  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  const requestedAgentId =
    typeof params.agentId === "string" && params.agentId.trim()
      ? params.agentId
      : typeof params.job.agentId === "string" && params.job.agentId.trim()
        ? params.job.agentId
        : undefined;
  const normalizedRequested = requestedAgentId ? normalizeAgentId(requestedAgentId) : undefined;
  const agentConfigOverride = normalizedRequested
    ? resolveAgentConfig(params.cfg, normalizedRequested)
    : undefined;
  const { model: overrideModel, ...agentOverrideRest } = agentConfigOverride ?? {};
  const agentId = agentConfigOverride ? (normalizedRequested ?? defaultAgentId) : defaultAgentId;
  const agentCfg: AgentDefaultsConfig = Object.assign(
    {},
    params.cfg.agents?.defaults,
    agentOverrideRest as Partial<AgentDefaultsConfig>,
  );
  if (typeof overrideModel === "string") {
    agentCfg.model = { primary: overrideModel };
  } else if (overrideModel) {
    agentCfg.model = overrideModel;
  }
  const cfgWithAgentDefaults: ClawdbotConfig = {
    ...params.cfg,
    agents: Object.assign({}, params.cfg.agents, { defaults: agentCfg }),
  };

  const baseSessionKey = (params.sessionKey?.trim() || `cron:${params.job.id}`).trim();
  const agentSessionKey = buildAgentMainSessionKey({
    agentId,
    mainKey: baseSessionKey,
  });

  const workspaceDirRaw = resolveAgentWorkspaceDir(params.cfg, agentId);
  const agentDir = resolveAgentDir(params.cfg, agentId);
  const workspace = await ensureAgentWorkspace({
    dir: workspaceDirRaw,
    ensureBootstrapFiles: !agentCfg?.skipBootstrap,
  });
  const workspaceDir = workspace.dir;

  const resolvedDefault = resolveConfiguredModelRef({
    cfg: cfgWithAgentDefaults,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  let provider = resolvedDefault.provider;
  let model = resolvedDefault.model;
  let catalog: Awaited<ReturnType<typeof loadModelCatalog>> | undefined;
  const loadCatalog = async () => {
    if (!catalog) {
      catalog = await loadModelCatalog({ config: cfgWithAgentDefaults });
    }
    return catalog;
  };
  // Resolve model - prefer hooks.gmail.model for Gmail hooks.
  const isGmailHook = baseSessionKey.startsWith("hook:gmail:");
  const hooksGmailModelRef = isGmailHook
    ? resolveHooksGmailModel({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
      })
    : null;
  if (hooksGmailModelRef) {
    const status = getModelRefStatus({
      cfg: params.cfg,
      catalog: await loadCatalog(),
      ref: hooksGmailModelRef,
      defaultProvider: resolvedDefault.provider,
      defaultModel: resolvedDefault.model,
    });
    if (status.allowed) {
      provider = hooksGmailModelRef.provider;
      model = hooksGmailModelRef.model;
    }
  }
  const modelOverrideRaw =
    params.job.payload.kind === "agentTurn" ? params.job.payload.model : undefined;
  if (modelOverrideRaw !== undefined) {
    if (typeof modelOverrideRaw !== "string") {
      return { status: "error", error: "invalid model: expected string" };
    }
    const resolvedOverride = resolveAllowedModelRef({
      cfg: cfgWithAgentDefaults,
      catalog: await loadCatalog(),
      raw: modelOverrideRaw,
      defaultProvider: resolvedDefault.provider,
      defaultModel: resolvedDefault.model,
    });
    if ("error" in resolvedOverride) {
      return { status: "error", error: resolvedOverride.error };
    }
    provider = resolvedOverride.ref.provider;
    model = resolvedOverride.ref.model;
  }
  const now = Date.now();
  const cronSession = resolveCronSession({
    cfg: params.cfg,
    sessionKey: agentSessionKey,
    agentId,
    nowMs: now,
  });

  // Resolve thinking level - job thinking > hooks.gmail.thinking > agent default
  const hooksGmailThinking = isGmailHook
    ? normalizeThinkLevel(params.cfg.hooks?.gmail?.thinking)
    : undefined;
  const thinkOverride = normalizeThinkLevel(agentCfg?.thinkingDefault);
  const jobThink = normalizeThinkLevel(
    (params.job.payload.kind === "agentTurn" ? params.job.payload.thinking : undefined) ??
      undefined,
  );
  let thinkLevel = jobThink ?? hooksGmailThinking ?? thinkOverride;
  if (!thinkLevel) {
    thinkLevel = resolveThinkingDefault({
      cfg: cfgWithAgentDefaults,
      provider,
      model,
      catalog: await loadCatalog(),
    });
  }
  if (thinkLevel === "xhigh" && !supportsXHighThinking(provider, model)) {
    throw new Error(`Thinking level "xhigh" is only supported for ${formatXHighModelHint()}.`);
  }

  const timeoutMs = resolveAgentTimeoutMs({
    cfg: cfgWithAgentDefaults,
    overrideSeconds:
      params.job.payload.kind === "agentTurn" ? params.job.payload.timeoutSeconds : undefined,
  });

  const agentPayload = params.job.payload.kind === "agentTurn" ? params.job.payload : null;
  const deliveryMode =
    agentPayload?.deliver === true ? "explicit" : agentPayload?.deliver === false ? "off" : "auto";
  const hasExplicitTarget = Boolean(agentPayload?.to && agentPayload.to.trim());
  const deliveryRequested =
    deliveryMode === "explicit" || (deliveryMode === "auto" && hasExplicitTarget);
  const bestEffortDeliver = agentPayload?.bestEffortDeliver === true;

  const resolvedDelivery = await resolveDeliveryTarget(cfgWithAgentDefaults, agentId, {
    channel: agentPayload?.channel ?? "last",
    to: agentPayload?.to,
  });

  const userTimezone = resolveUserTimezone(params.cfg.agents?.defaults?.userTimezone);
  const userTimeFormat = resolveUserTimeFormat(params.cfg.agents?.defaults?.timeFormat);
  const formattedTime =
    formatUserTime(new Date(now), userTimezone, userTimeFormat) ?? new Date(now).toISOString();
  const timeLine = `Current time: ${formattedTime} (${userTimezone})`;
  const base = `[cron:${params.job.id} ${params.job.name}] ${params.message}`.trim();

  // SECURITY: Wrap external hook content with security boundaries to prevent prompt injection
  // unless explicitly allowed via a dangerous config override.
  const isExternalHook = isExternalHookSession(baseSessionKey);
  const allowUnsafeExternalContent =
    agentPayload?.allowUnsafeExternalContent === true ||
    (isGmailHook && params.cfg.hooks?.gmail?.allowUnsafeExternalContent === true);
  const shouldWrapExternal = isExternalHook && !allowUnsafeExternalContent;
  let commandBody: string;

  if (isExternalHook) {
    // Log suspicious patterns for security monitoring
    const suspiciousPatterns = detectSuspiciousPatterns(params.message);
    if (suspiciousPatterns.length > 0) {
      logWarn(
        `[security] Suspicious patterns detected in external hook content ` +
          `(session=${baseSessionKey}, patterns=${suspiciousPatterns.length}): ` +
          `${suspiciousPatterns.slice(0, 3).join(", ")}`,
      );
    }
  }

  if (shouldWrapExternal) {
    // Wrap external content with security boundaries
    const hookType = getHookType(baseSessionKey);
    const safeContent = buildSafeExternalPrompt({
      content: params.message,
      source: hookType,
      jobName: params.job.name,
      jobId: params.job.id,
      timestamp: formattedTime,
    });

    commandBody = `${safeContent}\n\n${timeLine}`.trim();
  } else {
    // Internal/trusted source - use original format
    commandBody = `${base}\n${timeLine}`.trim();
  }

  if (baseSessionKey.startsWith("cron:")) {
    const contextLines = readRecentMainSessionContext({
      cfg: params.cfg,
      agentId,
    });
    if (contextLines.length > 0) {
      commandBody = `${commandBody}\n\n${MAIN_CONTEXT_HEADER}\n${contextLines.join("\n")}`;
    }
  }

  const existingSnapshot = cronSession.sessionEntry.skillsSnapshot;
  const skillsSnapshotVersion = getSkillsSnapshotVersion(workspaceDir);
  const needsSkillsSnapshot =
    !existingSnapshot || existingSnapshot.version !== skillsSnapshotVersion;
  const skillsSnapshot = needsSkillsSnapshot
    ? buildWorkspaceSkillSnapshot(workspaceDir, {
        config: cfgWithAgentDefaults,
        eligibility: { remote: getRemoteSkillEligibility() },
        snapshotVersion: skillsSnapshotVersion,
      })
    : cronSession.sessionEntry.skillsSnapshot;
  if (needsSkillsSnapshot && skillsSnapshot) {
    cronSession.sessionEntry = {
      ...cronSession.sessionEntry,
      updatedAt: Date.now(),
      skillsSnapshot,
    };
    cronSession.store[agentSessionKey] = cronSession.sessionEntry;
    await updateSessionStore(cronSession.storePath, (store) => {
      store[agentSessionKey] = cronSession.sessionEntry;
    });
  }

  // Persist systemSent before the run, mirroring the inbound auto-reply behavior.
  cronSession.sessionEntry.systemSent = true;
  cronSession.store[agentSessionKey] = cronSession.sessionEntry;
  await updateSessionStore(cronSession.storePath, (store) => {
    store[agentSessionKey] = cronSession.sessionEntry;
  });

  let runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
  let fallbackProvider = provider;
  let fallbackModel = model;
  try {
    const sessionFile = resolveSessionFilePath(
      cronSession.sessionEntry.sessionId,
      cronSession.sessionEntry,
      { agentId },
    );
    if (cronSession.sessionEntry.sessionFile !== sessionFile) {
      cronSession.sessionEntry.sessionFile = sessionFile;
    }
    const resolvedVerboseLevel =
      normalizeVerboseLevel(cronSession.sessionEntry.verboseLevel) ??
      normalizeVerboseLevel(agentCfg?.verboseDefault) ??
      "off";
    registerAgentRunContext(cronSession.sessionEntry.sessionId, {
      sessionKey: agentSessionKey,
      verboseLevel: resolvedVerboseLevel,
    });
    const messageChannel = resolvedDelivery.channel;
    const fallbackResult = await runWithModelFallback({
      cfg: cfgWithAgentDefaults,
      provider,
      model,
      agentDir,
      fallbacksOverride: resolveAgentModelFallbacksOverride(params.cfg, agentId),
      run: (providerOverride, modelOverride) => {
        if (isCliProvider(providerOverride, cfgWithAgentDefaults)) {
          const cliSessionId = getCliSessionId(cronSession.sessionEntry, providerOverride);
          return runCliAgent({
            sessionId: cronSession.sessionEntry.sessionId,
            sessionKey: agentSessionKey,
            sessionFile,
            workspaceDir,
            config: cfgWithAgentDefaults,
            prompt: commandBody,
            provider: providerOverride,
            model: modelOverride,
            thinkLevel,
            timeoutMs,
            runId: cronSession.sessionEntry.sessionId,
            cliSessionId,
          });
        }
        return runEmbeddedPiAgent({
          sessionId: cronSession.sessionEntry.sessionId,
          sessionKey: agentSessionKey,
          messageChannel,
          agentAccountId: resolvedDelivery.accountId,
          sessionFile,
          workspaceDir,
          config: cfgWithAgentDefaults,
          skillsSnapshot,
          prompt: commandBody,
          lane: params.lane ?? "cron",
          provider: providerOverride,
          model: modelOverride,
          thinkLevel,
          verboseLevel: resolvedVerboseLevel,
          timeoutMs,
          runId: cronSession.sessionEntry.sessionId,
        });
      },
    });
    runResult = fallbackResult.result;
    fallbackProvider = fallbackResult.provider;
    fallbackModel = fallbackResult.model;
  } catch (err) {
    return { status: "error", error: String(err) };
  }

  const payloads = runResult.payloads ?? [];

  // Update token+model fields in the session store.
  {
    const usage = runResult.meta.agentMeta?.usage;
    const modelUsed = runResult.meta.agentMeta?.model ?? fallbackModel ?? model;
    const providerUsed = runResult.meta.agentMeta?.provider ?? fallbackProvider ?? provider;
    const contextTokens =
      agentCfg?.contextTokens ?? lookupContextTokens(modelUsed) ?? DEFAULT_CONTEXT_TOKENS;

    cronSession.sessionEntry.modelProvider = providerUsed;
    cronSession.sessionEntry.model = modelUsed;
    cronSession.sessionEntry.contextTokens = contextTokens;
    if (isCliProvider(providerUsed, cfgWithAgentDefaults)) {
      const cliSessionId = runResult.meta.agentMeta?.sessionId?.trim();
      if (cliSessionId) {
        setCliSessionId(cronSession.sessionEntry, providerUsed, cliSessionId);
      }
    }
    if (hasNonzeroUsage(usage)) {
      const input = usage.input ?? 0;
      const output = usage.output ?? 0;
      const promptTokens = input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
      cronSession.sessionEntry.inputTokens = input;
      cronSession.sessionEntry.outputTokens = output;
      cronSession.sessionEntry.totalTokens =
        promptTokens > 0 ? promptTokens : (usage.total ?? input);
    }
    cronSession.store[agentSessionKey] = cronSession.sessionEntry;
    await updateSessionStore(cronSession.storePath, (store) => {
      store[agentSessionKey] = cronSession.sessionEntry;
    });
  }
  const firstText = payloads[0]?.text ?? "";
  const summary = pickSummaryFromPayloads(payloads) ?? pickSummaryFromOutput(firstText);
  const outputText = pickLastNonEmptyTextFromPayloads(payloads);

  // Skip delivery for heartbeat-only responses (HEARTBEAT_OK with no real content).
  const ackMaxChars = resolveHeartbeatAckMaxChars(agentCfg);
  const skipHeartbeatDelivery = deliveryRequested && isHeartbeatOnlyResponse(payloads, ackMaxChars);
  const skipMessagingToolDelivery =
    deliveryRequested &&
    deliveryMode === "auto" &&
    runResult.didSendViaMessagingTool === true &&
    (runResult.messagingToolSentTargets ?? []).some((target) =>
      matchesMessagingToolDeliveryTarget(target, {
        channel: resolvedDelivery.channel,
        to: resolvedDelivery.to,
        accountId: resolvedDelivery.accountId,
      }),
    );

  if (deliveryRequested && !skipHeartbeatDelivery && !skipMessagingToolDelivery) {
    if (!resolvedDelivery.to) {
      const reason =
        resolvedDelivery.error?.message ?? "Cron delivery requires a recipient (--to).";
      if (!bestEffortDeliver) {
        return {
          status: "error",
          summary,
          outputText,
          error: reason,
          nonRetryable: true,
        };
      }
      return {
        status: "skipped",
        summary: `Delivery skipped (${reason}).`,
        outputText,
        nonRetryable: true,
      };
    }
    try {
      const outboundRoute = await resolveOutboundSessionRoute({
        cfg: cfgWithAgentDefaults,
        channel: resolvedDelivery.channel,
        agentId,
        accountId: resolvedDelivery.accountId,
        target: resolvedDelivery.to,
      });
      if (outboundRoute) {
        await ensureOutboundSessionEntry({
          cfg: cfgWithAgentDefaults,
          agentId,
          channel: resolvedDelivery.channel,
          accountId: resolvedDelivery.accountId,
          route: outboundRoute,
        });
      }
      const mirrorText = payloads
        .map((payload) => payload.text?.trim())
        .filter((text): text is string => Boolean(text))
        .join("\n");
      const mirrorMediaUrls = payloads.flatMap(
        (payload) => payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []),
      );
      await deliverOutboundPayloads({
        cfg: cfgWithAgentDefaults,
        channel: resolvedDelivery.channel,
        to: resolvedDelivery.to,
        accountId: resolvedDelivery.accountId,
        payloads,
        bestEffort: bestEffortDeliver,
        deps: createOutboundSendDeps(params.deps),
        mirror: outboundRoute
          ? {
              sessionKey: outboundRoute.sessionKey,
              agentId,
              text: mirrorText || undefined,
              mediaUrls: mirrorMediaUrls.length > 0 ? mirrorMediaUrls : undefined,
            }
          : undefined,
      });
    } catch (err) {
      const errorText = normalizeErrorText(err);
      const nonRetryable = isNonRetryableDeliveryError(err, errorText);
      if (!bestEffortDeliver) {
        return {
          status: "error",
          summary,
          outputText,
          error: errorText,
          nonRetryable,
        };
      }
      return { status: "ok", summary, outputText };
    }
  }

  return { status: "ok", summary, outputText };
}
