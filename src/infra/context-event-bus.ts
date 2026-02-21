import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveStorePath } from "../config/sessions.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";

export type ContextEvent = {
  seq: number;
  ts: number;
  sessionKey: string;
  source: string;
  sourceId: string;
  hash: string;
  idempotencyKey: string;
  text: string;
  contextKey?: string;
  metadata?: Record<string, string | number | boolean | null>;
};

export type ContextEventAppendInput = {
  ts?: number;
  sessionKey: string;
  source: string;
  sourceId: string;
  hash: string;
  idempotencyKey: string;
  text: string;
  contextKey?: string;
  metadata?: Record<string, string | number | boolean | null>;
};

type ContextEventBusState = {
  filePath: string;
  events: ContextEvent[];
  byKey: Map<string, ContextEvent>;
  nextSeq: number;
};

const EVENT_BUS_FILENAME = "context-events.jsonl";
const MAX_EVENTS_IN_MEMORY = 8_000;
const MAX_EVENT_FILE_BYTES = 6_000_000;
const KEEP_EVENT_LINES = 5_000;

const busByPath = new Map<string, ContextEventBusState>();

function resolveEventBusPath(sessionKey: string): string {
  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  if (process.env.VITEST) {
    return path.join(
      os.tmpdir(),
      `clawdbot-test-context-events-${process.pid}`,
      `${agentId}-${EVENT_BUS_FILENAME}`,
    );
  }
  const storePath = resolveStorePath(undefined, { agentId });
  return path.join(path.dirname(storePath), EVENT_BUS_FILENAME);
}

function parseContextEvent(line: string): ContextEvent | null {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line) as Partial<ContextEvent> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.seq !== "number" || !Number.isFinite(parsed.seq)) return null;
    if (typeof parsed.ts !== "number" || !Number.isFinite(parsed.ts)) return null;
    if (typeof parsed.sessionKey !== "string" || !parsed.sessionKey.trim()) return null;
    if (typeof parsed.source !== "string" || !parsed.source.trim()) return null;
    if (typeof parsed.sourceId !== "string" || !parsed.sourceId.trim()) return null;
    if (typeof parsed.hash !== "string" || !parsed.hash.trim()) return null;
    if (typeof parsed.idempotencyKey !== "string" || !parsed.idempotencyKey.trim()) return null;
    if (typeof parsed.text !== "string" || !parsed.text.trim()) return null;
    const metadata =
      parsed.metadata && typeof parsed.metadata === "object" && !Array.isArray(parsed.metadata)
        ? (parsed.metadata as Record<string, string | number | boolean | null>)
        : undefined;
    return {
      seq: parsed.seq,
      ts: parsed.ts,
      sessionKey: parsed.sessionKey,
      source: parsed.source,
      sourceId: parsed.sourceId,
      hash: parsed.hash,
      idempotencyKey: parsed.idempotencyKey,
      text: parsed.text,
      contextKey:
        typeof parsed.contextKey === "string" && parsed.contextKey.trim()
          ? parsed.contextKey
          : undefined,
      metadata,
    };
  } catch {
    return null;
  }
}

function pruneLoadedEvents(events: ContextEvent[]): ContextEvent[] {
  if (events.length <= MAX_EVENTS_IN_MEMORY) return events;
  return events.slice(events.length - MAX_EVENTS_IN_MEMORY);
}

function rebuildByKey(events: ContextEvent[]): Map<string, ContextEvent> {
  const map = new Map<string, ContextEvent>();
  for (const event of events) {
    map.set(event.idempotencyKey, event);
  }
  return map;
}

function loadBusState(filePath: string): ContextEventBusState {
  const existing = busByPath.get(filePath);
  if (existing) return existing;

  let events: ContextEvent[] = [];
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    events = raw
      .split("\n")
      .map((line) => parseContextEvent(line))
      .filter((event): event is ContextEvent => Boolean(event));
    events.sort((a, b) => a.seq - b.seq);
    events = pruneLoadedEvents(events);
  } catch {
    events = [];
  }
  const nextSeq = (events[events.length - 1]?.seq ?? 0) + 1;
  const state: ContextEventBusState = {
    filePath,
    events,
    byKey: rebuildByKey(events),
    nextSeq,
  };
  busByPath.set(filePath, state);
  return state;
}

function pruneEventFileIfNeeded(state: ContextEventBusState) {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(state.filePath);
  } catch {
    return;
  }
  if (stat.size <= MAX_EVENT_FILE_BYTES) return;
  const kept = state.events.slice(Math.max(0, state.events.length - KEEP_EVENT_LINES));
  const tmp = `${state.filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, `${kept.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf-8");
    fs.renameSync(tmp, state.filePath);
    state.events = kept;
    state.byKey = rebuildByKey(kept);
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
  }
}

export function appendContextEvent(
  input: ContextEventAppendInput,
): { appended: true; event: ContextEvent } | { appended: false; event: ContextEvent } {
  const filePath = resolveEventBusPath(input.sessionKey);
  const state = loadBusState(filePath);
  const duplicate = state.byKey.get(input.idempotencyKey);
  if (duplicate) {
    return { appended: false, event: duplicate };
  }

  const event: ContextEvent = {
    seq: state.nextSeq++,
    ts: input.ts ?? Date.now(),
    sessionKey: input.sessionKey,
    source: input.source,
    sourceId: input.sourceId,
    hash: input.hash,
    idempotencyKey: input.idempotencyKey,
    text: input.text,
    contextKey: input.contextKey,
    metadata: input.metadata,
  };

  state.events.push(event);
  state.byKey.set(event.idempotencyKey, event);
  if (state.events.length > MAX_EVENTS_IN_MEMORY) {
    state.events = state.events.slice(state.events.length - MAX_EVENTS_IN_MEMORY);
    state.byKey = rebuildByKey(state.events);
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf-8");
  pruneEventFileIfNeeded(state);

  return { appended: true, event };
}

export function queryContextEvents(params: {
  sessionKey?: string;
  source?: string;
  afterSeq?: number;
  limit?: number;
}): ContextEvent[] {
  const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
  if (!sessionKey) return [];
  const filePath = resolveEventBusPath(sessionKey);
  const state = loadBusState(filePath);
  const source = typeof params.source === "string" ? params.source.trim().toLowerCase() : "";
  const afterSeq =
    typeof params.afterSeq === "number" && Number.isFinite(params.afterSeq)
      ? Math.floor(params.afterSeq)
      : 0;
  const limitRaw =
    typeof params.limit === "number" && Number.isFinite(params.limit)
      ? Math.floor(params.limit)
      : 200;
  const limit = Math.max(1, Math.min(2_000, limitRaw));
  const result = state.events.filter((event) => {
    if (event.sessionKey !== sessionKey) return false;
    if (event.seq <= afterSeq) return false;
    if (source && event.source.toLowerCase() !== source) return false;
    return true;
  });
  if (result.length <= limit) return result.slice();
  return result.slice(result.length - limit);
}

export function getContextEventLatestSeq(sessionKey: string): number {
  const resolved = sessionKey.trim();
  if (!resolved) return 0;
  const filePath = resolveEventBusPath(resolved);
  const state = loadBusState(filePath);
  return state.events[state.events.length - 1]?.seq ?? 0;
}

export function resetContextEventBusForTest() {
  for (const state of busByPath.values()) {
    try {
      fs.rmSync(state.filePath, { force: true });
    } catch {
      // ignore
    }
  }
  busByPath.clear();
}
