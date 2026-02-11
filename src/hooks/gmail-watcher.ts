/**
 * Gmail Watcher Service
 *
 * Automatically starts `gog gmail watch serve` when the gateway starts,
 * if hooks.gmail is configured with an account (supports multi-account mode).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { hasBinary } from "../agents/skills.js";
import type {
  ClawdbotConfig,
  HooksGmailAccountConfig,
  HooksGmailConfig,
} from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runCommandWithTimeout } from "../process/exec.js";
import {
  buildGogWatchServeArgs,
  buildGogWatchStartArgs,
  type GmailHookRuntimeConfig,
  resolveGmailHookRuntimeConfigFrom,
} from "./gmail.js";
import { ensureTailscaleEndpoint } from "./gmail-setup-utils.js";

const log = createSubsystemLogger("gmail-watcher");

const ADDRESS_IN_USE_RE = /address already in use|EADDRINUSE/i;

export function isAddressInUseError(line: string): boolean {
  return ADDRESS_IN_USE_RE.test(line);
}

let shuttingDown = false;

type GmailWatcherInstance = {
  key: string;
  config: GmailHookRuntimeConfig;
  process: ChildProcess | null;
  renewInterval: ReturnType<typeof setInterval> | null;
};

const instances = new Map<string, GmailWatcherInstance>();

export type GmailWatcherResolvedRuntimeConfig = {
  key: string;
  config: GmailHookRuntimeConfig;
};

export type ResolveGmailWatcherRuntimeConfigsResult =
  | {
      ok: true;
      value: GmailWatcherResolvedRuntimeConfig[];
      warnings: string[];
      errors: string[];
    }
  | {
      ok: false;
      error: string;
      warnings: string[];
      errors: string[];
    };

export function resolveGmailWatcherRuntimeConfigs(
  cfg: ClawdbotConfig,
): ResolveGmailWatcherRuntimeConfigsResult {
  const gmailRoot = cfg.hooks?.gmail;
  if (!gmailRoot) {
    return { ok: false, error: "no gmail hooks configured", warnings: [], errors: [] };
  }

  const runtimeConfigs: GmailWatcherResolvedRuntimeConfig[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  // Multi-account mode: hooks.gmail.accounts (each merged with hooks.gmail defaults).
  const { accounts, account: rootAccount, ...defaults } = gmailRoot;
  const seenAccounts = new Set<string>();
  const usedKeys = new Set<string>();

  const reserveKey = (desiredKey: string, fallbackAccount: string): string => {
    const desired = desiredKey.trim();
    const fallback = fallbackAccount.trim();
    let key = desired || fallback;
    if (!key) return key;
    if (!usedKeys.has(key)) {
      usedKeys.add(key);
      return key;
    }
    if (fallback && !usedKeys.has(fallback)) {
      warnings.push(
        `[gmail] duplicate watcher key "${key}" detected; using account key instead: ${fallback}`,
      );
      usedKeys.add(fallback);
      return fallback;
    }
    let i = 2;
    while (usedKeys.has(`${key}#${i}`)) i++;
    const next = `${key}#${i}`;
    warnings.push(`[gmail] duplicate watcher key "${key}" detected; using unique key: ${next}`);
    usedKeys.add(next);
    return next;
  };

  const collect = (desiredKey: string, gmailConfig: HooksGmailConfig | HooksGmailAccountConfig) => {
    const resolved = resolveGmailHookRuntimeConfigFrom(cfg, gmailConfig, {});
    if (!resolved.ok) {
      errors.push(`[${desiredKey}] ${resolved.error}`);
      return;
    }
    const key = reserveKey(desiredKey, resolved.value.account);
    runtimeConfigs.push({ key, config: resolved.value });
  };

  const addAccount = (desiredKey: string, entry: HooksGmailAccountConfig) => {
    const normalized = entry.account.trim().toLowerCase();
    if (!normalized) return;
    if (seenAccounts.has(normalized)) {
      warnings.push(`[gmail] duplicate account configured; skipping: ${entry.account}`);
      return;
    }
    seenAccounts.add(normalized);
    collect(desiredKey, entry);
  };

  if (Array.isArray(accounts)) {
    for (const entry of accounts) {
      if (!entry || typeof entry !== "object") continue;
      const account = typeof entry.account === "string" ? entry.account.trim() : "";
      if (!account) continue;
      const merged: HooksGmailAccountConfig = {
        ...defaults,
        ...entry,
        account,
        serve: { ...defaults.serve, ...entry.serve },
        tailscale: { ...defaults.tailscale, ...entry.tailscale },
      };
      addAccount(entry.id?.trim() || account, merged);
    }
  }

  // Back-compat single-account mode: hooks.gmail.account
  if (typeof rootAccount === "string" && rootAccount.trim()) {
    const account = rootAccount.trim();
    const normalized = account.toLowerCase();
    if (!seenAccounts.has(normalized)) {
      seenAccounts.add(normalized);
      collect(account, { ...gmailRoot, account, accounts: undefined });
    } else {
      warnings.push(`[gmail] duplicate account configured; skipping root account: ${account}`);
    }
  }

  if (runtimeConfigs.length === 0) {
    const detail = errors.length > 0 ? errors.join("; ") : "no gmail account configured";
    return { ok: false, error: detail, warnings, errors };
  }

  return { ok: true, value: runtimeConfigs, warnings, errors };
}

/**
 * Check if gog binary is available
 */
function isGogAvailable(): boolean {
  return hasBinary("gog");
}

/**
 * Start the Gmail watch (registers with Gmail API)
 */
async function startGmailWatch(
  cfg: Pick<GmailHookRuntimeConfig, "account" | "label" | "topic">,
  key?: string,
): Promise<boolean> {
  const args = ["gog", ...buildGogWatchStartArgs(cfg)];
  try {
    const result = await runCommandWithTimeout(args, { timeoutMs: 120_000 });
    if (result.code !== 0) {
      const message = result.stderr || result.stdout || "gog watch start failed";
      log.error(`${key ? `[${key}] ` : ""}watch start failed: ${message}`);
      return false;
    }
    log.info(`${key ? `[${key}] ` : ""}watch started for ${cfg.account}`);
    return true;
  } catch (err) {
    log.error(`${key ? `[${key}] ` : ""}watch start error: ${String(err)}`);
    return false;
  }
}

/**
 * Spawn the gog gmail watch serve process
 */
function spawnGogServe(instance: GmailWatcherInstance): ChildProcess {
  const cfg = instance.config;
  const args = buildGogWatchServeArgs(cfg);
  log.info(`[${instance.key}] starting gog ${args.join(" ")}`);
  let addressInUse = false;

  const child = spawn("gog", args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  child.stdout?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) log.info(`[${instance.key}] [gog] ${line}`);
  });

  child.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (!line) return;
    if (isAddressInUseError(line)) {
      addressInUse = true;
    }
    log.warn(`[${instance.key}] [gog] ${line}`);
  });

  child.on("error", (err) => {
    log.error(`[${instance.key}] gog process error: ${String(err)}`);
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    if (addressInUse) {
      log.warn(
        `[${instance.key}] gog serve failed to bind (address already in use); stopping restarts. ` +
          "Another watcher is likely running. Set CLAWDBOT_SKIP_GMAIL_WATCHER=1 or stop the other process.",
      );
      instance.process = null;
      return;
    }
    log.warn(`[${instance.key}] gog exited (code=${code}, signal=${signal}); restarting in 5s`);
    instance.process = null;
    setTimeout(() => {
      if (shuttingDown) return;
      const latest = instances.get(instance.key);
      if (!latest) return;
      latest.process = spawnGogServe(latest);
    }, 5000);
  });

  return child;
}

export type GmailWatcherStartResult = {
  started: boolean;
  reason?: string;
};

/**
 * Start the Gmail watcher service.
 * Called automatically by the gateway if hooks.gmail is configured.
 */
export async function startGmailWatcher(cfg: ClawdbotConfig): Promise<GmailWatcherStartResult> {
  // Check if gmail hooks are configured
  if (!cfg.hooks?.enabled) {
    return { started: false, reason: "hooks not enabled" };
  }

  // Check if gog is available
  const gogAvailable = isGogAvailable();
  if (!gogAvailable) {
    return { started: false, reason: "gog binary not found" };
  }

  // Defensive: avoid leaking subprocesses if start is called twice without stop.
  if (instances.size > 0 && !shuttingDown) {
    log.warn("gmail watcher already running; restarting");
    await stopGmailWatcher().catch(() => {});
  }

  const gmailRoot = cfg.hooks?.gmail;
  if (!gmailRoot) {
    return { started: false, reason: "no gmail hooks configured" };
  }

  const resolved = resolveGmailWatcherRuntimeConfigs(cfg);
  for (const warning of resolved.warnings) {
    log.warn(warning);
  }
  for (const err of resolved.errors) {
    log.warn(err);
  }
  if (!resolved.ok) {
    return { started: false, reason: resolved.error };
  }

  // Set up Tailscale endpoint if needed
  shuttingDown = false;

  // Clear any previous instances (shouldn't happen in normal startup, but keep it safe).
  instances.clear();

  for (const { key, config: runtimeConfig } of resolved.value) {
    const instance: GmailWatcherInstance = {
      key,
      config: runtimeConfig,
      process: null,
      renewInterval: null,
    };
    instances.set(key, instance);

    if (runtimeConfig.tailscale.mode !== "off") {
      try {
        await ensureTailscaleEndpoint({
          mode: runtimeConfig.tailscale.mode,
          path: runtimeConfig.tailscale.path,
          port: runtimeConfig.serve.port,
          target: runtimeConfig.tailscale.target,
        });
        log.info(
          `[${key}] tailscale ${runtimeConfig.tailscale.mode} configured for port ${runtimeConfig.serve.port}`,
        );
      } catch (err) {
        log.error(`[${key}] tailscale setup failed: ${String(err)}`);
        // Keep other accounts running; this one won't be started.
        instances.delete(key);
        continue;
      }
    }

    const watchStarted = await startGmailWatch(runtimeConfig, key);
    if (!watchStarted) {
      log.warn(`[${key}] gmail watch start failed, but continuing with serve`);
    }

    instance.process = spawnGogServe(instance);

    const renewMs = runtimeConfig.renewEveryMinutes * 60_000;
    instance.renewInterval = setInterval(() => {
      if (shuttingDown) return;
      void startGmailWatch(runtimeConfig, key);
    }, renewMs);

    log.info(
      `[${key}] gmail watcher started for ${runtimeConfig.account} (renew every ${runtimeConfig.renewEveryMinutes}m)`,
    );
  }

  if (instances.size === 0) {
    return {
      started: false,
      reason: "gmail watcher not started: all accounts failed validation or tailscale setup",
    };
  }

  return { started: true };
}

/**
 * Stop the Gmail watcher service.
 */
export async function stopGmailWatcher(): Promise<void> {
  shuttingDown = true;

  const active = Array.from(instances.values());
  instances.clear();

  for (const instance of active) {
    if (instance.renewInterval) {
      clearInterval(instance.renewInterval);
      instance.renewInterval = null;
    }
  }

  for (const instance of active) {
    const proc = instance.process;
    if (!proc) continue;
    log.info(`[${instance.key}] stopping gmail watcher`);
    proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore
        }
        resolve();
      }, 3000);
      proc.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    instance.process = null;
  }

  log.info("gmail watcher stopped");
}

/**
 * Check if the Gmail watcher is running.
 */
export function isGmailWatcherRunning(): boolean {
  return instances.size > 0 && !shuttingDown;
}
