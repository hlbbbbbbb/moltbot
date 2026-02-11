import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  type ClawdbotConfig,
  DEFAULT_GATEWAY_PORT,
  loadConfig,
  resolveGatewayPort,
  resolveStateDir,
} from "../config/config.js";
import { type CommandOptions, runCommandWithTimeout } from "../process/exec.js";
import { normalizeHooksPath } from "./gmail.js";

export const DEFAULT_IMAP_FOLDER = "INBOX";
export const DEFAULT_IMAP_PAGE_SIZE = 50;
export const DEFAULT_IMAP_MAX_MESSAGES = 10;
export const DEFAULT_IMAP_BODY_MAX_BYTES = 4_000;
export const DEFAULT_IMAP_HOOK_PATH = "imap";
export const DEFAULT_IMAP_TIMEOUT_MS = 30_000;

const MAX_STATE_KEYS = 4_000;
const ENVELOPE_LIST_KEYS = ["envelopes", "messages", "items", "data"] as const;

export type ImapPollOptions = {
  account?: string;
  folder?: string;
  pageSize?: number;
  maxMessages?: number;
  stateFile?: string;
  hookUrl?: string;
  hookToken?: string;
  source?: string;
  himalayaBin?: string;
  timeoutMs?: number;
  includeBody?: boolean;
  bodyMaxBytes?: number;
  dryRun?: boolean;
  bootstrap?: boolean;
  config?: ClawdbotConfig;
};

export type ImapPollRuntimeConfig = {
  account: string;
  folder: string;
  pageSize: number;
  maxMessages: number;
  stateFile: string;
  hookUrl: string;
  hookToken?: string;
  source: string;
  himalayaBin: string;
  timeoutMs: number;
  includeBody: boolean;
  bodyMaxBytes: number;
  dryRun: boolean;
  bootstrap: boolean;
};

export type ImapPollResult = {
  status: "idle" | "bootstrapped" | "sent" | "dry-run";
  account: string;
  folder: string;
  scanned: number;
  newMessages: number;
  delivered: number;
  stateFile: string;
  hookUrl: string;
  dryRun: boolean;
};

type ImapPollState = {
  seen: string[];
  updatedAt?: string;
};

export type NormalizedImapEnvelope = {
  id?: string;
  key: string;
  messageId?: string;
  from: string;
  subject: string;
  date?: string;
  snippet?: string;
};

type CommandRunner = (
  argv: string[],
  optionsOrTimeout: number | CommandOptions,
) => ReturnType<typeof runCommandWithTimeout>;

type PostHookParams = {
  url: string;
  token: string;
  payload: Record<string, unknown>;
  timeoutMs: number;
};

type PostHookFn = (params: PostHookParams) => Promise<void>;

type ReadFileFn = (filePath: string) => Promise<string>;
type WriteFileFn = (filePath: string, content: string) => Promise<void>;
type MkdirFn = (dirPath: string) => Promise<void>;

export type ImapPollDeps = {
  runCommand?: CommandRunner;
  postHook?: PostHookFn;
  readFile?: ReadFileFn;
  writeFile?: WriteFileFn;
  mkdir?: MkdirFn;
  now?: () => Date;
};

export function buildDefaultImapHookUrl(
  hooksPath?: string,
  port: number = DEFAULT_GATEWAY_PORT,
): string {
  const basePath = normalizeHooksPath(hooksPath);
  return `http://127.0.0.1:${port}${basePath}/${DEFAULT_IMAP_HOOK_PATH}`;
}

export function buildDefaultImapStateFile(
  account: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const stateDir = resolveStateDir(env, os.homedir);
  const safeAccount =
    account
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "_") || "default";
  return path.join(stateDir, "hooks", "imap", `${safeAccount}.json`);
}

export function resolveImapPollRuntimeConfig(
  cfg: ClawdbotConfig,
  opts: ImapPollOptions,
): { ok: true; value: ImapPollRuntimeConfig } | { ok: false; error: string } {
  const account = opts.account?.trim() ?? "";
  if (!account) {
    return { ok: false, error: "--account is required" };
  }

  const folder = opts.folder?.trim() || DEFAULT_IMAP_FOLDER;
  const pageSize = normalizePositiveInt(opts.pageSize, DEFAULT_IMAP_PAGE_SIZE);
  const maxMessages = normalizePositiveInt(opts.maxMessages, DEFAULT_IMAP_MAX_MESSAGES);
  const bodyMaxBytes = normalizePositiveInt(opts.bodyMaxBytes, DEFAULT_IMAP_BODY_MAX_BYTES);
  const timeoutMs = normalizePositiveInt(opts.timeoutMs, DEFAULT_IMAP_TIMEOUT_MS);

  const hookUrl =
    opts.hookUrl?.trim() || buildDefaultImapHookUrl(cfg.hooks?.path, resolveGatewayPort(cfg));
  const hookToken = opts.hookToken?.trim() || cfg.hooks?.token?.trim() || undefined;

  const dryRun = opts.dryRun === true;
  if (!dryRun && !hookToken) {
    return {
      ok: false,
      error: "hook token required (set hooks.token, --hook-token, or use --dry-run)",
    };
  }

  const source = opts.source?.trim() || "imap";
  const himalayaBin = opts.himalayaBin?.trim() || "himalaya";
  const stateFile = opts.stateFile?.trim() || buildDefaultImapStateFile(account);

  return {
    ok: true,
    value: {
      account,
      folder,
      pageSize,
      maxMessages,
      stateFile,
      hookUrl,
      hookToken,
      source,
      himalayaBin,
      timeoutMs,
      includeBody: opts.includeBody === true,
      bodyMaxBytes,
      dryRun,
      bootstrap: opts.bootstrap !== false,
    },
  };
}

export function extractHimalayaEnvelopes(raw: unknown): NormalizedImapEnvelope[] {
  const items = unwrapEnvelopePayload(raw);
  const envelopes: NormalizedImapEnvelope[] = [];
  for (const item of items) {
    const normalized = normalizeEnvelope(item);
    if (normalized) envelopes.push(normalized);
  }
  return envelopes;
}

export function extractHimalayaEnvelopesFromJson(stdout: string): NormalizedImapEnvelope[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch (err) {
    throw new Error(`failed to parse himalaya JSON: ${String(err)}`);
  }
  return extractHimalayaEnvelopes(parsed);
}

export async function runImapPoll(
  opts: ImapPollOptions,
  deps: ImapPollDeps = {},
): Promise<ImapPollResult> {
  const cfg = opts.config ?? loadConfig();
  const resolved = resolveImapPollRuntimeConfig(cfg, opts);
  if (!resolved.ok) {
    throw new Error(resolved.error);
  }

  const runtime = resolved.value;
  const runCommand = deps.runCommand ?? runCommandWithTimeout;
  const postHook = deps.postHook ?? postHookJson;
  const readFile = deps.readFile ?? defaultReadFile;
  const writeFile = deps.writeFile ?? defaultWriteFile;
  const mkdir = deps.mkdir ?? defaultMkdir;
  const now = deps.now ?? (() => new Date());

  const state = await loadState(runtime.stateFile, readFile);
  const envelopes = await listEnvelopes(runtime, runCommand);
  const envelopeKeys = envelopes.map((entry) => entry.key);

  if (!state.exists && runtime.bootstrap && envelopeKeys.length > 0) {
    const seededSeen = mergeSeen([], envelopeKeys);
    await saveState(runtime.stateFile, seededSeen, now(), mkdir, writeFile);
    return {
      status: "bootstrapped",
      account: runtime.account,
      folder: runtime.folder,
      scanned: envelopes.length,
      newMessages: 0,
      delivered: 0,
      stateFile: runtime.stateFile,
      hookUrl: runtime.hookUrl,
      dryRun: runtime.dryRun,
    };
  }

  const seenSet = new Set(state.value.seen);
  const newEnvelopes = envelopes
    .filter((entry) => !seenSet.has(entry.key))
    .slice(0, runtime.maxMessages);

  if (newEnvelopes.length === 0) {
    const nextSeen = mergeSeen(state.value.seen, envelopeKeys);
    await saveState(runtime.stateFile, nextSeen, now(), mkdir, writeFile);
    return {
      status: "idle",
      account: runtime.account,
      folder: runtime.folder,
      scanned: envelopes.length,
      newMessages: 0,
      delivered: 0,
      stateFile: runtime.stateFile,
      hookUrl: runtime.hookUrl,
      dryRun: runtime.dryRun,
    };
  }

  const messages = await buildHookMessages(newEnvelopes, runtime, runCommand);
  const payload: Record<string, unknown> = {
    source: runtime.source,
    provider: "himalaya",
    account: runtime.account,
    folder: runtime.folder,
    polledAt: now().toISOString(),
    messages,
  };

  if (!runtime.dryRun) {
    await postHook({
      url: runtime.hookUrl,
      token: runtime.hookToken ?? "",
      payload,
      timeoutMs: runtime.timeoutMs,
    });
  }

  if (!runtime.dryRun) {
    // Mark only successfully forwarded messages as seen so backlog isn't dropped.
    const sentKeys = newEnvelopes.map((entry) => entry.key);
    const nextSeen = mergeSeen(state.value.seen, sentKeys);
    await saveState(runtime.stateFile, nextSeen, now(), mkdir, writeFile);
  }

  return {
    status: runtime.dryRun ? "dry-run" : "sent",
    account: runtime.account,
    folder: runtime.folder,
    scanned: envelopes.length,
    newMessages: newEnvelopes.length,
    delivered: runtime.dryRun ? 0 : 1,
    stateFile: runtime.stateFile,
    hookUrl: runtime.hookUrl,
    dryRun: runtime.dryRun,
  };
}

async function listEnvelopes(
  runtime: ImapPollRuntimeConfig,
  runCommand: CommandRunner,
): Promise<NormalizedImapEnvelope[]> {
  const fetchWithPageSize = async (pageSize: number) => {
    const argv = [
      runtime.himalayaBin,
      "envelope",
      "list",
      "--folder",
      runtime.folder,
      "--page",
      "1",
      "--page-size",
      String(pageSize),
      "--output",
      "json",
      "--account",
      runtime.account,
    ];

    const result = await runCommand(argv, { timeoutMs: runtime.timeoutMs });
    if (result.code !== 0) {
      return {
        ok: false as const,
        message: extractCommandFailure(result, "himalaya envelope list failed"),
        stderr: result.stderr,
      };
    }

    return {
      ok: true as const,
      envelopes: extractHimalayaEnvelopesFromJson(result.stdout),
      stderr: result.stderr,
    };
  };

  const primary = await fetchWithPageSize(runtime.pageSize);
  if (primary.ok) {
    const recovered = await recoverInvalidFetchEnvelopes(primary.stderr, runtime, runCommand);
    return mergeRecoveredEnvelopes(primary.envelopes, recovered);
  }

  const primaryMessage = primary.message;
  if (runtime.pageSize > 1 && isKnownHimalayaEmptyMailboxError(primaryMessage)) {
    // QQ IMAP can return "Sequence set is inavlid" when page-size is larger
    // than the available envelope count. Retry with page-size=1 as fallback.
    const fallback = await fetchWithPageSize(1);
    if (fallback.ok) {
      const recovered = await recoverInvalidFetchEnvelopes(fallback.stderr, runtime, runCommand);
      return mergeRecoveredEnvelopes(fallback.envelopes, recovered);
    }
    if (isKnownHimalayaEmptyMailboxError(fallback.message)) {
      return [];
    }
    throw new Error(fallback.message);
  }

  if (isKnownHimalayaEmptyMailboxError(primaryMessage)) {
    return [];
  }
  throw new Error(primaryMessage);
}

async function recoverInvalidFetchEnvelopes(
  stderr: string,
  runtime: ImapPollRuntimeConfig,
  runCommand: CommandRunner,
): Promise<NormalizedImapEnvelope[]> {
  const invalidIds = parseInvalidFetchIds(stderr);
  if (invalidIds.length === 0) return [];

  const recovered: NormalizedImapEnvelope[] = [];
  for (const id of invalidIds) {
    const envelope = await readEnvelopeFromMessage(id, runtime, runCommand);
    if (envelope) recovered.push(envelope);
  }
  return recovered;
}

async function readEnvelopeFromMessage(
  id: string,
  runtime: ImapPollRuntimeConfig,
  runCommand: CommandRunner,
): Promise<NormalizedImapEnvelope | null> {
  const raw = await readMessageBody(id, runtime, runCommand);
  if (!raw) return null;

  const parsed = parseMessageForEnvelope(raw);
  const messageId = parsed.messageId;
  const key = messageId ? `mid:${messageId}` : `id:${id}`;
  return {
    id,
    key,
    messageId,
    from: parsed.from ?? "",
    subject: parsed.subject ?? "(no subject)",
    date: parsed.date,
    snippet: parsed.snippet,
  };
}

function parseMessageForEnvelope(raw: string): {
  from?: string;
  subject?: string;
  date?: string;
  messageId?: string;
  snippet?: string;
} {
  const normalized = raw.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const headerBlock = parts.shift() ?? "";
  const body = parts.join("\n\n").trim();
  const headers = parseRfc822Headers(headerBlock);

  return {
    from: headers.get("from"),
    subject: headers.get("subject"),
    date: headers.get("date"),
    messageId: headers.get("message-id"),
    snippet: body ? body.slice(0, 200) : undefined,
  };
}

function parseRfc822Headers(block: string): Map<string, string> {
  const headers = new Map<string, string>();
  const lines = block.split("\n");
  let currentKey: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    if (!line) continue;

    if ((line.startsWith(" ") || line.startsWith("\t")) && currentKey) {
      const previous = headers.get(currentKey) ?? "";
      headers.set(currentKey, `${previous} ${line.trim()}`.trim());
      continue;
    }

    const separator = line.indexOf(":");
    if (separator <= 0) {
      currentKey = null;
      continue;
    }

    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers.set(key, value);
    currentKey = key;
  }

  return headers;
}

function parseInvalidFetchIds(stderr: string): string[] {
  const normalized = stderr.trim();
  if (!normalized.toLowerCase().includes("skipping invalid fetch")) return [];

  const ids = new Set<string>();
  const matches = normalized.matchAll(/\bUID\s+(\d+)\b/g);
  for (const match of matches) {
    const id = match[1]?.trim();
    if (id) ids.add(id);
  }

  return Array.from(ids);
}

function mergeRecoveredEnvelopes(
  list: NormalizedImapEnvelope[],
  recovered: NormalizedImapEnvelope[],
): NormalizedImapEnvelope[] {
  if (recovered.length === 0) return list;

  const merged = [...recovered, ...list];
  const unique: NormalizedImapEnvelope[] = [];
  const seen = new Set<string>();
  for (const envelope of merged) {
    if (seen.has(envelope.key)) continue;
    seen.add(envelope.key);
    unique.push(envelope);
  }

  unique.sort((left, right) => {
    const leftId = Number.parseInt(left.id ?? "", 10);
    const rightId = Number.parseInt(right.id ?? "", 10);
    if (Number.isFinite(leftId) && Number.isFinite(rightId) && leftId !== rightId) {
      return rightId - leftId;
    }
    return 0;
  });
  return unique;
}

async function buildHookMessages(
  envelopes: NormalizedImapEnvelope[],
  runtime: ImapPollRuntimeConfig,
  runCommand: CommandRunner,
): Promise<Array<Record<string, unknown>>> {
  const messages: Array<Record<string, unknown>> = [];

  for (const envelope of envelopes) {
    let body: string | undefined;
    if (runtime.includeBody && envelope.id) {
      const bodyRaw = await readMessageBody(envelope.id, runtime, runCommand);
      if (bodyRaw) {
        body = truncateBytes(bodyRaw, runtime.bodyMaxBytes);
      }
    }

    messages.push({
      id: envelope.id,
      key: envelope.key,
      messageId: envelope.messageId,
      from: envelope.from,
      subject: envelope.subject,
      date: envelope.date,
      snippet: envelope.snippet,
      body,
    });
  }

  return messages;
}

async function readMessageBody(
  id: string,
  runtime: ImapPollRuntimeConfig,
  runCommand: CommandRunner,
): Promise<string | undefined> {
  const argv = [
    runtime.himalayaBin,
    "message",
    "read",
    id,
    "--folder",
    runtime.folder,
    "--account",
    runtime.account,
  ];
  const result = await runCommand(argv, { timeoutMs: runtime.timeoutMs });
  if (result.code !== 0) {
    return undefined;
  }
  const body = result.stdout.trim();
  return body || undefined;
}

async function postHookJson(params: PostHookParams): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const response = await fetch(params.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawdbot-token": params.token,
      },
      body: JSON.stringify(params.payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).trim();
      const reason = body || `${response.status} ${response.statusText}`.trim();
      throw new Error(`hook request failed: ${reason}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function loadState(
  filePath: string,
  readFile: ReadFileFn,
): Promise<{ exists: boolean; value: ImapPollState }> {
  try {
    const raw = await readFile(filePath);
    const parsed = JSON.parse(raw) as unknown;
    const state = normalizeState(parsed);
    return { exists: true, value: state };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return { exists: false, value: { seen: [] } };
    }
    return { exists: true, value: { seen: [] } };
  }
}

async function saveState(
  filePath: string,
  seen: string[],
  now: Date,
  mkdir: MkdirFn,
  writeFile: WriteFileFn,
): Promise<void> {
  await mkdir(path.dirname(filePath));
  const payload: ImapPollState = {
    seen,
    updatedAt: now.toISOString(),
  };
  await writeFile(filePath, JSON.stringify(payload, null, 2));
}

function normalizeState(raw: unknown): ImapPollState {
  if (!isRecord(raw)) return { seen: [] };
  const seen = Array.isArray(raw.seen)
    ? raw.seen.map((entry) => asString(entry)).filter((entry): entry is string => Boolean(entry))
    : [];
  const updatedAt = asString(raw.updatedAt);
  return {
    seen,
    updatedAt,
  };
}

function mergeSeen(previous: string[], nextKeys: string[]): string[] {
  const merged = new Set<string>();
  for (const key of previous) {
    if (key.trim()) merged.add(key);
  }
  for (const key of nextKeys) {
    if (key.trim()) merged.add(key);
  }
  const all = Array.from(merged);
  if (all.length <= MAX_STATE_KEYS) return all;
  return all.slice(all.length - MAX_STATE_KEYS);
}

function unwrapEnvelopePayload(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!isRecord(raw)) return [];
  for (const key of ENVELOPE_LIST_KEYS) {
    const candidate = raw[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function normalizeEnvelope(entry: unknown): NormalizedImapEnvelope | null {
  if (!isRecord(entry)) return null;

  const id =
    asString(entry.id) ??
    asString(entry.uid) ??
    asString(entry.seq) ??
    asString(entry.sequence) ??
    asString(entry.index);
  const messageId =
    asString(entry.messageId) ??
    asString(entry.messageID) ??
    asString(entry["message-id"]) ??
    asString(entry["message_id"]);

  const key = messageId ? `mid:${messageId}` : id ? `id:${id}` : undefined;
  if (!key) return null;

  return {
    id,
    key,
    messageId,
    from: normalizeAddress(entry.from),
    subject: asString(entry.subject) ?? "(no subject)",
    date: asString(entry.date),
    snippet:
      asString(entry.snippet) ??
      asString(entry.preview) ??
      asString(entry.bodyPreview) ??
      undefined,
  };
}

function normalizeAddress(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    const joined = value
      .map((entry) => normalizeAddress(entry))
      .filter(Boolean)
      .join(", ");
    return joined;
  }
  if (!isRecord(value)) return "";

  const name = asString(value.name) ?? asString(value.displayName);
  const address = asString(value.addr) ?? asString(value.address) ?? asString(value.email);
  if (name && address) return `${name} <${address}>`;
  return name ?? address ?? "";
}

function truncateBytes(input: string, maxBytes: number): string {
  if (!input) return "";
  if (Buffer.byteLength(input, "utf8") <= maxBytes) return input;
  let out = input;
  while (out.length > 0 && Buffer.byteLength(out, "utf8") > maxBytes) {
    out = out.slice(0, -1);
  }
  return out;
}

function extractCommandFailure(
  result: { stdout: string; stderr: string },
  fallback: string,
): string {
  const stderr = result.stderr.trim();
  if (stderr) return stderr;
  const stdout = result.stdout.trim();
  if (stdout) return stdout;
  return fallback;
}

function isKnownHimalayaEmptyMailboxError(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes("sequence set is inavlid") ||
    normalized.includes("sequence set is invalid") ||
    normalized.includes("uid parameters")
  );
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

async function defaultReadFile(filePath: string): Promise<string> {
  return await fs.readFile(filePath, "utf8");
}

async function defaultWriteFile(filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, content, "utf8");
}

async function defaultMkdir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}
