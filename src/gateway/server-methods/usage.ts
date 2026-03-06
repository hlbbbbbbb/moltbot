import type { SessionSystemPromptReport } from "../../config/sessions/types.js";
import { loadConfig } from "../../config/config.js";
import type { CostUsageSummary, SessionCostSummary } from "../../infra/session-cost-usage.js";
import { loadCostUsageSummary, loadSessionCostSummary } from "../../infra/session-cost-usage.js";
import { loadProviderUsageSummary } from "../../infra/provider-usage.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSessionsUsageParams,
} from "../protocol/index.js";
import { loadCombinedSessionStoreForGateway } from "../session-utils.js";
import type { GatewayRequestHandlers } from "./types.js";

const COST_USAGE_CACHE_TTL_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;

type DateRange = { startMs: number; endMs: number };

type CostUsageCacheEntry = {
  summary?: CostUsageSummary;
  updatedAt?: number;
  inFlight?: Promise<CostUsageSummary>;
};

const costUsageCache = new Map<string, CostUsageCacheEntry>();

const parseDateToMs = (raw: unknown): number | undefined => {
  if (typeof raw !== "string" || !raw.trim()) {
    return undefined;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!match) {
    return undefined;
  }
  const [, year, month, day] = match;
  const ms = Date.UTC(
    Number.parseInt(year, 10),
    Number.parseInt(month, 10) - 1,
    Number.parseInt(day, 10),
  );
  return Number.isNaN(ms) ? undefined : ms;
};

const parseDays = (raw: unknown): number | undefined => {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.floor(raw);
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed);
    }
  }
  return undefined;
};

const parseDateRange = (params: {
  startDate?: unknown;
  endDate?: unknown;
  days?: unknown;
}): DateRange => {
  const now = new Date();
  const todayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const todayEndMs = todayStartMs + DAY_MS - 1;

  const startMs = parseDateToMs(params.startDate);
  const endMs = parseDateToMs(params.endDate);
  if (startMs !== undefined && endMs !== undefined) {
    return { startMs, endMs: endMs + DAY_MS - 1 };
  }

  const days = parseDays(params.days);
  if (days !== undefined) {
    const clampedDays = Math.max(1, days);
    const start = todayStartMs - (clampedDays - 1) * DAY_MS;
    return { startMs: start, endMs: todayEndMs };
  }

  return { startMs: todayStartMs - 29 * DAY_MS, endMs: todayEndMs };
};

const formatUtcDate = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
};

const createEmptyTotals = (): CostUsageSummary["totals"] => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  totalCost: 0,
  missingCostEntries: 0,
});

const mergeTotals = (
  target: CostUsageSummary["totals"],
  source: Pick<
    CostUsageSummary["totals"],
    | "input"
    | "output"
    | "cacheRead"
    | "cacheWrite"
    | "totalTokens"
    | "totalCost"
    | "missingCostEntries"
  >,
) => {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.totalTokens += source.totalTokens;
  target.totalCost += source.totalCost;
  target.missingCostEntries += source.missingCostEntries;
};

async function loadCostUsageSummaryCached(params: {
  startMs: number;
  endMs: number;
  config: ReturnType<typeof loadConfig>;
}): Promise<CostUsageSummary> {
  const cacheKey = `${params.startMs}-${params.endMs}`;
  const now = Date.now();
  const cached = costUsageCache.get(cacheKey);
  if (cached?.summary && cached.updatedAt && now - cached.updatedAt < COST_USAGE_CACHE_TTL_MS) {
    return cached.summary;
  }

  if (cached?.inFlight) {
    if (cached.summary) {
      return cached.summary;
    }
    return await cached.inFlight;
  }

  const entry: CostUsageCacheEntry = cached ?? {};
  const inFlight = loadCostUsageSummary({
    startMs: params.startMs,
    endMs: params.endMs,
    config: params.config,
  })
    .then((summary) => {
      costUsageCache.set(cacheKey, { summary, updatedAt: Date.now() });
      return summary;
    })
    .catch((err) => {
      if (entry.summary) {
        return entry.summary;
      }
      throw err;
    })
    .finally(() => {
      const current = costUsageCache.get(cacheKey);
      if (current?.inFlight === inFlight) {
        current.inFlight = undefined;
        costUsageCache.set(cacheKey, current);
      }
    });

  entry.inFlight = inFlight;
  costUsageCache.set(cacheKey, entry);

  if (entry.summary) {
    return entry.summary;
  }
  return await inFlight;
}

export type SessionUsageEntry = {
  key: string;
  label?: string;
  sessionId?: string;
  updatedAt?: number;
  agentId?: string;
  channel?: string;
  chatType?: string;
  modelOverride?: string;
  providerOverride?: string;
  modelProvider?: string;
  model?: string;
  usage: SessionCostSummary | null;
  contextWeight?: SessionSystemPromptReport | null;
};

export type SessionsUsageResult = {
  updatedAt: number;
  startDate: string;
  endDate: string;
  sessions: SessionUsageEntry[];
  totals: CostUsageSummary["totals"];
};

export const usageHandlers: GatewayRequestHandlers = {
  "usage.status": async ({ respond }) => {
    const summary = await loadProviderUsageSummary();
    respond(true, summary, undefined);
  },
  "usage.cost": async ({ respond, params }) => {
    const config = loadConfig();
    const { startMs, endMs } = parseDateRange({
      startDate: params?.startDate,
      endDate: params?.endDate,
      days: params?.days,
    });
    const summary = await loadCostUsageSummaryCached({ startMs, endMs, config });
    respond(true, summary, undefined);
  },
  "sessions.usage": async ({ respond, params }) => {
    if (!validateSessionsUsageParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.usage params: ${formatValidationErrors(validateSessionsUsageParams.errors)}`,
        ),
      );
      return;
    }

    const config = loadConfig();
    const { store } = loadCombinedSessionStoreForGateway(config);
    const specificKey = typeof params.key === "string" ? params.key.trim() : "";
    const limit = Math.max(1, Math.floor(params.limit ?? 50));
    const includeContextWeight = params.includeContextWeight === true;
    const { startMs, endMs } = parseDateRange({
      startDate: params.startDate,
      endDate: params.endDate,
      days: params.days,
    });

    const entries = Object.entries(store)
      .filter(([key]) => (specificKey ? key === specificKey : true))
      .sort(([, a], [, b]) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, limit);

    if (specificKey && entries.length === 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${specificKey}`),
      );
      return;
    }

    const sessions: SessionUsageEntry[] = [];
    const totals = createEmptyTotals();
    for (const [key, entry] of entries) {
      const usage = await loadSessionCostSummary({
        sessionId: entry.sessionId,
        sessionEntry: entry,
        config,
        startMs,
        endMs,
      });
      if (usage) {
        mergeTotals(totals, usage);
      }
      const parsed = parseAgentSessionKey(key);
      sessions.push({
        key,
        label: entry.label,
        sessionId: entry.sessionId,
        updatedAt: entry.updatedAt,
        agentId: parsed?.agentId,
        channel: entry.channel ?? entry.origin?.provider,
        chatType: entry.chatType ?? entry.origin?.chatType,
        modelOverride: entry.modelOverride,
        providerOverride: entry.providerOverride,
        modelProvider: entry.modelProvider,
        model: entry.model,
        usage,
        contextWeight: includeContextWeight ? (entry.systemPromptReport ?? null) : undefined,
      });
    }

    const result: SessionsUsageResult = {
      updatedAt: Date.now(),
      startDate: formatUtcDate(startMs),
      endDate: formatUtcDate(endMs),
      sessions,
      totals,
    };

    respond(true, result, undefined);
  },
};
