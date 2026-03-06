import crypto from "node:crypto";

import type { ClawdbotConfig } from "../../config/config.js";
import {
  loadSessionStore,
  resolveSessionFilePath,
  resolveStorePath,
  type SessionEntry,
} from "../../config/sessions.js";

export function resolveCronSession(params: {
  cfg: ClawdbotConfig;
  sessionKey: string;
  nowMs: number;
  agentId: string;
}) {
  const sessionCfg = params.cfg.session;
  const storePath = resolveStorePath(sessionCfg?.store, {
    agentId: params.agentId,
  });
  const store = loadSessionStore(storePath);
  const entry = store[params.sessionKey];
  const existingSessionId = entry?.sessionId?.trim();
  const sessionId = existingSessionId || crypto.randomUUID();
  const systemSent = entry?.systemSent ?? false;
  const isNewSession = !existingSessionId;
  const sessionEntry: SessionEntry = {
    ...(entry ?? {}),
    sessionId,
    sessionFile: resolveSessionFilePath(sessionId, entry, {
      agentId: params.agentId,
    }),
    updatedAt: params.nowMs,
    systemSent,
  };
  return { storePath, store, sessionEntry, systemSent, isNewSession };
}
