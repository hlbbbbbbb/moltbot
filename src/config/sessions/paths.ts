import os from "node:os";
import path from "node:path";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import { resolveStateDir } from "../paths.js";
import type { SessionEntry } from "./types.js";

function resolveAgentSessionsDir(
  agentId?: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const root = resolveStateDir(env, homedir);
  const id = normalizeAgentId(agentId ?? DEFAULT_AGENT_ID);
  return path.join(root, "agents", id, "sessions");
}

export function resolveSessionTranscriptsDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  return resolveAgentSessionsDir(DEFAULT_AGENT_ID, env, homedir);
}

export function resolveSessionTranscriptsDirForAgent(
  agentId?: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  return resolveAgentSessionsDir(agentId, env, homedir);
}

export function resolveDefaultSessionStorePath(agentId?: string): string {
  return path.join(resolveAgentSessionsDir(agentId), "sessions.json");
}

export function resolveSessionTranscriptPath(
  sessionId: string,
  agentId?: string,
  topicId?: string | number,
): string {
  const safeTopicId =
    typeof topicId === "string"
      ? encodeURIComponent(topicId)
      : typeof topicId === "number"
        ? String(topicId)
        : undefined;
  const fileName =
    safeTopicId !== undefined ? `${sessionId}-topic-${safeTopicId}.jsonl` : `${sessionId}.jsonl`;
  return path.join(resolveAgentSessionsDir(agentId), fileName);
}

function inferAgentIdFromSessionFileCandidate(candidate?: string): string | undefined {
  const raw = candidate?.trim();
  if (!raw) return undefined;
  const normalized = path.normalize(raw);
  const parts = normalized.split(path.sep);
  const agentsIndex = parts.lastIndexOf("agents");
  if (agentsIndex < 0) return undefined;
  const guessedAgentId = parts[agentsIndex + 1]?.trim();
  const sessionsMarker = parts[agentsIndex + 2];
  if (!guessedAgentId || sessionsMarker !== "sessions") return undefined;
  return guessedAgentId;
}

function inferSessionFileNameFromCandidate(candidate?: string): string | undefined {
  const raw = candidate?.trim();
  if (!raw) return undefined;
  const base = path.basename(path.normalize(raw));
  if (!base || base === "." || base === "/" || !base.endsWith(".jsonl")) return undefined;
  return base;
}

export function resolveSessionFilePath(
  sessionId: string,
  entry?: SessionEntry,
  opts?: { agentId?: string },
): string {
  const candidate = entry?.sessionFile?.trim();
  const inferredAgentId = opts?.agentId ?? inferAgentIdFromSessionFileCandidate(candidate);
  const fallbackFileName = inferSessionFileNameFromCandidate(candidate);
  const fallbackPath = fallbackFileName
    ? path.join(resolveSessionTranscriptsDirForAgent(inferredAgentId), fallbackFileName)
    : resolveSessionTranscriptPath(sessionId, inferredAgentId);
  if (!candidate) return fallbackPath;

  const resolvedCandidate = path.resolve(candidate);
  const expectedRoot = opts?.agentId
    ? resolveSessionTranscriptsDirForAgent(opts.agentId)
    : path.join(resolveStateDir(), "agents");
  const relative = path.relative(expectedRoot, resolvedCandidate);
  const withinRoot =
    relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));

  if (!withinRoot) return fallbackPath;
  return resolvedCandidate;
}

export function resolveStorePath(store?: string, opts?: { agentId?: string }) {
  const agentId = normalizeAgentId(opts?.agentId ?? DEFAULT_AGENT_ID);
  if (!store) return resolveDefaultSessionStorePath(agentId);
  if (store.includes("{agentId}")) {
    const expanded = store.replaceAll("{agentId}", agentId);
    if (expanded.startsWith("~")) {
      return path.resolve(expanded.replace(/^~(?=$|[\\/])/, os.homedir()));
    }
    return path.resolve(expanded);
  }
  if (store.startsWith("~")) return path.resolve(store.replace(/^~(?=$|[\\/])/, os.homedir()));
  return path.resolve(store);
}
