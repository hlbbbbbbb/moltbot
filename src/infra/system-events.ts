import crypto from "node:crypto";

import {
  appendContextEvent,
  getContextEventLatestSeq,
  queryContextEvents,
  resetContextEventBusForTest,
} from "./context-event-bus.js";

// Session-local queue used for immediate "prepend to next prompt" behavior.
// Each event is also written to the durable context event bus for idempotency
// and heartbeat cursor processing.
export type SystemEvent = {
  text: string;
  ts: number;
  seq?: number;
  source?: string;
  sourceId?: string;
  hash?: string;
  idempotencyKey?: string;
};

const MAX_EVENTS = 20;

type SessionQueue = {
  queue: SystemEvent[];
  lastContextKey: string | null;
};

const queues = new Map<string, SessionQueue>();

type SystemEventOptions = {
  sessionKey: string;
  contextKey?: string | null;
  source?: string;
  sourceId?: string;
  hash?: string;
  idempotencyKey?: string;
  metadata?: Record<string, string | number | boolean | null>;
};

function requireSessionKey(key?: string | null): string {
  const trimmed = typeof key === "string" ? key.trim() : "";
  if (!trimmed) {
    throw new Error("system events require a sessionKey");
  }
  return trimmed;
}

function normalizeContextKey(key?: string | null): string | null {
  if (!key) return null;
  const trimmed = key.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}

function normalizeSource(source?: string | null): string {
  const trimmed = typeof source === "string" ? source.trim().toLowerCase() : "";
  return trimmed || "system";
}

function normalizeSourceId(input: {
  sourceId?: string;
  contextKey?: string | null;
  sessionKey: string;
}): string {
  const explicit = typeof input.sourceId === "string" ? input.sourceId.trim() : "";
  if (explicit) return explicit;
  const context = normalizeContextKey(input.contextKey);
  if (context) return context;
  return input.sessionKey;
}

function resolveEventHash(text: string, hash?: string): string {
  const explicit = typeof hash === "string" ? hash.trim().toLowerCase() : "";
  if (explicit) return explicit;
  return crypto.createHash("sha1").update(text).digest("hex");
}

function resolveIdempotencyKey(input: {
  source: string;
  sourceId: string;
  hash: string;
  idempotencyKey?: string;
}): string {
  const explicit =
    typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim().toLowerCase() : "";
  if (explicit) return explicit;
  return `${input.source}:${input.sourceId}:${input.hash}`;
}

function toSystemEventFromBus(event: {
  text: string;
  ts: number;
  seq: number;
  source: string;
  sourceId: string;
  hash: string;
  idempotencyKey: string;
}): SystemEvent {
  return {
    text: event.text,
    ts: event.ts,
    seq: event.seq,
    source: event.source,
    sourceId: event.sourceId,
    hash: event.hash,
    idempotencyKey: event.idempotencyKey,
  };
}

export function isSystemEventContextChanged(
  sessionKey: string,
  contextKey?: string | null,
): boolean {
  const key = requireSessionKey(sessionKey);
  const existing = queues.get(key);
  const normalized = normalizeContextKey(contextKey);
  return normalized !== (existing?.lastContextKey ?? null);
}

export function enqueueSystemEvent(text: string, options: SystemEventOptions) {
  const key = requireSessionKey(options?.sessionKey);
  const entry =
    queues.get(key) ??
    (() => {
      const created: SessionQueue = {
        queue: [],
        lastContextKey: null,
      };
      queues.set(key, created);
      return created;
    })();
  const cleaned = text.trim();
  if (!cleaned) return;

  const source = normalizeSource(options?.source);
  const sourceId = normalizeSourceId({
    sourceId: options?.sourceId,
    contextKey: options?.contextKey,
    sessionKey: key,
  });
  const hash = resolveEventHash(cleaned, options?.hash);
  const idempotencyKey = resolveIdempotencyKey({
    source,
    sourceId,
    hash,
    idempotencyKey: options?.idempotencyKey,
  });

  const appended = appendContextEvent({
    sessionKey: key,
    source,
    sourceId,
    hash,
    idempotencyKey,
    text: cleaned,
    contextKey: normalizeContextKey(options?.contextKey) ?? undefined,
    metadata: options?.metadata,
  });
  entry.lastContextKey = normalizeContextKey(options?.contextKey);
  if (!appended.appended) return;
  entry.queue.push(toSystemEventFromBus(appended.event));
  if (entry.queue.length > MAX_EVENTS) entry.queue.shift();
}

export function drainSystemEventEntries(sessionKey: string): SystemEvent[] {
  const key = requireSessionKey(sessionKey);
  const entry = queues.get(key);
  if (!entry || entry.queue.length === 0) return [];
  const out = entry.queue.slice();
  entry.queue.length = 0;
  entry.lastContextKey = null;
  queues.delete(key);
  return out;
}

export function drainSystemEvents(sessionKey: string): string[] {
  return drainSystemEventEntries(sessionKey).map((event) => event.text);
}

export function peekSystemEvents(sessionKey: string): string[] {
  const key = requireSessionKey(sessionKey);
  return queues.get(key)?.queue.map((e) => e.text) ?? [];
}

export function peekSystemEventEntriesSince(
  sessionKey: string,
  opts?: { afterSeq?: number; limit?: number },
): SystemEvent[] {
  const key = requireSessionKey(sessionKey);
  return queryContextEvents({
    sessionKey: key,
    afterSeq: opts?.afterSeq,
    limit: opts?.limit,
  }).map((event) => toSystemEventFromBus(event));
}

export function peekSystemEventsSince(
  sessionKey: string,
  opts?: { afterSeq?: number; limit?: number },
): string[] {
  return peekSystemEventEntriesSince(sessionKey, opts).map((event) => event.text);
}

export function getLatestSystemEventSeq(sessionKey: string): number {
  const key = requireSessionKey(sessionKey);
  return getContextEventLatestSeq(key);
}

export function hasSystemEvents(sessionKey: string) {
  const key = requireSessionKey(sessionKey);
  return (queues.get(key)?.queue.length ?? 0) > 0;
}

export function resetSystemEventsForTest() {
  queues.clear();
  resetContextEventBusForTest();
}
