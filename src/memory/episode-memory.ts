/**
 * Episodic Memory System
 *
 * Stores specific events with time, context, process, and outcomes.
 * Unlike semantic memory (KeyFact), episodic memory records "what happened".
 *
 * Storage path: workspace/episodes/YYYY-MM.json
 *
 * Features:
 * - Monthly storage to avoid large single files
 * - Pagination support to avoid memory issues
 * - Failed queue mechanism for embedding retry
 * - Integration with clawdbot's SQLite embedding system
 */

import fsSync from "node:fs";
import path from "node:path";

import { createSubsystemLogger } from "../logging/subsystem.js";
import { ensureDir } from "./internal.js";

const log = createSubsystemLogger("episode-memory");

// ========== Type Definitions ==========

/**
 * Episode data structure
 */
export interface Episode {
  id: string;
  timestamp: number;
  event: string; // Event description
  actions: string[]; // Actions taken
  files: string[]; // Files involved
  outcome: "success" | "partial" | "failed";
  userFeedback?: string; // User feedback
  emotionalContext?: string; // User emotional state
  duration?: number; // Duration in ms
  toolsUsed?: string[]; // Tools used
  sessionId?: string; // Session ID
  agentId?: string; // Agent ID
}

/**
 * Monthly episode store structure
 */
interface MonthlyEpisodeStore {
  month: string; // YYYY-MM
  episodes: Episode[];
  lastUpdated: number;
}

/**
 * Failed embedding task
 */
interface FailedEmbedding {
  episode: Episode;
  attempts: number;
  lastAttempt: number;
  error: string;
}

// ========== Constants ==========

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5 * 60 * 1000; // 5 minutes
const EPISODES_DIR = "episodes";

// ========== Failed Queue ==========

// In-memory failed queue (grouped by agentId)
const failedEmbeddingQueues = new Map<string, FailedEmbedding[]>();

function getFailedQueue(agentId: string): FailedEmbedding[] {
  let queue = failedEmbeddingQueues.get(agentId);
  if (!queue) {
    queue = [];
    failedEmbeddingQueues.set(agentId, queue);
  }
  return queue;
}

/**
 * Queue a failed embedding for retry
 */
function queueFailedEmbedding(agentId: string, episode: Episode, error: string): void {
  const queue = getFailedQueue(agentId);
  const existing = queue.find((f) => f.episode.id === episode.id);

  if (existing) {
    existing.attempts += 1;
    existing.lastAttempt = Date.now();
    existing.error = error;

    if (existing.attempts >= MAX_RETRY_ATTEMPTS) {
      const index = queue.indexOf(existing);
      queue.splice(index, 1);
      log.warn(`Episode ${episode.id} exceeded max retries, removed from queue`);
    }
  } else {
    queue.push({
      episode,
      attempts: 1,
      lastAttempt: Date.now(),
      error,
    });
  }

  log.debug(`Queued failed embedding: ${episode.id} (queue size: ${queue.length})`);
}

// ========== Utility Functions ==========

/**
 * Get episodes storage directory
 */
function getEpisodesPath(workspaceDir: string): string {
  const episodesPath = path.join(workspaceDir, EPISODES_DIR);
  ensureDir(episodesPath);
  return episodesPath;
}

/**
 * Get current month string
 */
function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Get file path for a specific month
 */
function getMonthFilePath(workspaceDir: string, month: string): string {
  return path.join(getEpisodesPath(workspaceDir), `${month}.json`);
}

/**
 * Read monthly episode store
 */
function readMonthlyStore(workspaceDir: string, month: string): MonthlyEpisodeStore {
  const filePath = getMonthFilePath(workspaceDir, month);

  if (fsSync.existsSync(filePath)) {
    try {
      const content = fsSync.readFileSync(filePath, "utf-8");
      return JSON.parse(content);
    } catch {
      log.warn(`Failed to read ${month} store, creating new one`);
    }
  }

  return {
    month,
    episodes: [],
    lastUpdated: Date.now(),
  };
}

/**
 * Save monthly episode store
 */
function saveMonthlyStore(workspaceDir: string, store: MonthlyEpisodeStore): void {
  const filePath = getMonthFilePath(workspaceDir, store.month);
  store.lastUpdated = Date.now();
  fsSync.writeFileSync(filePath, JSON.stringify(store, null, 2), "utf-8");
}

/**
 * Generate episode ID
 */
function generateEpisodeId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substr(2, 5);
  return `ep-${timestamp}-${random}`;
}

// ========== Core Functions ==========

/**
 * Record a new episode
 */
export function recordEpisode(
  workspaceDir: string,
  episode: Omit<Episode, "id" | "timestamp">,
): Episode {
  const month = getCurrentMonth();

  const newEpisode: Episode = {
    ...episode,
    id: generateEpisodeId(),
    timestamp: Date.now(),
  };

  const store = readMonthlyStore(workspaceDir, month);
  store.episodes.push(newEpisode);
  saveMonthlyStore(workspaceDir, store);

  log.info(`Recorded episode: ${newEpisode.event.slice(0, 50)}...`);

  return newEpisode;
}

/**
 * Format episode for embedding
 */
export function formatEpisodeForEmbedding(episode: Episode): string {
  const lines: string[] = [];

  lines.push(`## Event Record`);
  lines.push(`Event: ${episode.event}`);
  lines.push(`Time: ${new Date(episode.timestamp).toISOString()}`);
  lines.push(
    `Outcome: ${episode.outcome === "success" ? "Success" : episode.outcome === "partial" ? "Partial" : "Failed"}`,
  );

  if (episode.files.length > 0) {
    lines.push(`Files: ${episode.files.join(", ")}`);
  }

  if (episode.actions.length > 0) {
    lines.push(`Actions: ${episode.actions.join(" -> ")}`);
  }

  if (episode.userFeedback) {
    lines.push(`User Feedback: ${episode.userFeedback}`);
  }

  if (episode.emotionalContext) {
    lines.push(`Emotional Context: ${episode.emotionalContext}`);
  }

  if (episode.toolsUsed && episode.toolsUsed.length > 0) {
    lines.push(`Tools Used: ${episode.toolsUsed.join(", ")}`);
  }

  return lines.join("\n");
}

/**
 * Get episode by ID
 */
export function getEpisodeById(workspaceDir: string, episodeId: string): Episode | null {
  const match = episodeId.match(/^ep-([a-z0-9]+)-/);

  if (match) {
    try {
      const timestamp = parseInt(match[1], 36);
      const date = new Date(timestamp);
      const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

      const store = readMonthlyStore(workspaceDir, month);
      const found = store.episodes.find((e) => e.id === episodeId);
      if (found) {
        return found;
      }

      const prevMonth = new Date(date.getFullYear(), date.getMonth() - 1, 1);
      const nextMonth = new Date(date.getFullYear(), date.getMonth() + 1, 1);

      for (const d of [prevMonth, nextMonth]) {
        const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        const s = readMonthlyStore(workspaceDir, m);
        const f = s.episodes.find((e) => e.id === episodeId);
        if (f) return f;
      }
    } catch {
      // Fall back to full search
    }
  }

  const allEpisodes = getAllEpisodes(workspaceDir);
  return allEpisodes.find((e) => e.id === episodeId) || null;
}

/**
 * Get all episodes
 */
export function getAllEpisodes(workspaceDir: string): Episode[] {
  const episodesPath = getEpisodesPath(workspaceDir);

  if (!fsSync.existsSync(episodesPath)) {
    return [];
  }

  const files = fsSync
    .readdirSync(episodesPath)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();

  const allEpisodes: Episode[] = [];

  for (const file of files) {
    const month = file.replace(".json", "");
    const store = readMonthlyStore(workspaceDir, month);
    allEpisodes.push(...store.episodes);
  }

  allEpisodes.sort((a, b) => b.timestamp - a.timestamp);

  return allEpisodes;
}

/**
 * Get episodes count
 */
export function getEpisodesCount(workspaceDir: string): number {
  const episodesPath = getEpisodesPath(workspaceDir);

  if (!fsSync.existsSync(episodesPath)) {
    return 0;
  }

  const files = fsSync.readdirSync(episodesPath).filter((f) => f.endsWith(".json"));

  let total = 0;

  for (const file of files) {
    const month = file.replace(".json", "");
    const store = readMonthlyStore(workspaceDir, month);
    total += store.episodes.length;
  }

  return total;
}

/**
 * Get recent episodes (last N days)
 */
export function getRecentEpisodes(workspaceDir: string, days: number = 7): Episode[] {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return getAllEpisodes(workspaceDir).filter((e) => e.timestamp >= cutoff);
}

/**
 * Get episodes by file
 */
export function getEpisodesByFile(workspaceDir: string, filePath: string): Episode[] {
  const normalizedPath = filePath.toLowerCase();
  return getAllEpisodes(workspaceDir).filter((e) =>
    e.files.some((f) => f.toLowerCase().includes(normalizedPath)),
  );
}

/**
 * Search episodes by keyword
 */
export function searchEpisodesByKeyword(
  workspaceDir: string,
  query: string,
  topK: number = 5,
): Array<{ episode: Episode; score: number }> {
  const allEpisodes = getAllEpisodes(workspaceDir);
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/);

  const scored: Array<{ episode: Episode; score: number }> = [];

  for (const episode of allEpisodes) {
    let score = 0;
    const searchText = [
      episode.event,
      ...episode.actions,
      ...episode.files,
      episode.userFeedback || "",
    ]
      .join(" ")
      .toLowerCase();

    for (const word of queryWords) {
      if (searchText.includes(word)) {
        score += 1;
      }
    }

    if (score > 0) {
      scored.push({ episode, score: score / queryWords.length });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, topK);
}

/**
 * Format episodes for context injection
 */
export function formatEpisodesForContext(episodes: Episode[]): string {
  if (episodes.length === 0) {
    return "";
  }

  const lines: string[] = ["## Related Past Events"];

  for (const episode of episodes) {
    const date = new Date(episode.timestamp).toLocaleDateString();
    const outcome =
      episode.outcome === "success" ? "OK" : episode.outcome === "partial" ? "Partial" : "Failed";

    lines.push(`\n### ${date} [${outcome}] ${episode.event}`);

    if (episode.files.length > 0) {
      lines.push(`Files: ${episode.files.join(", ")}`);
    }

    if (episode.actions.length > 0) {
      lines.push(`Actions: ${episode.actions.join(" -> ")}`);
    }

    if (episode.userFeedback) {
      lines.push(`Feedback: ${episode.userFeedback}`);
    }
  }

  return lines.join("\n");
}

/**
 * Cleanup old episodes (keep recent N months)
 */
export function cleanupOldEpisodes(workspaceDir: string, keepMonths: number = 6): number {
  const episodesPath = getEpisodesPath(workspaceDir);

  if (!fsSync.existsSync(episodesPath)) {
    return 0;
  }

  const files = fsSync
    .readdirSync(episodesPath)
    .filter((f) => f.endsWith(".json"))
    .sort();

  if (files.length <= keepMonths) {
    return 0;
  }

  const filesToDelete = files.slice(0, files.length - keepMonths);
  let deletedCount = 0;

  for (const file of filesToDelete) {
    const filePath = path.join(episodesPath, file);
    fsSync.unlinkSync(filePath);
    log.info(`Deleted old episode store: ${file}`);
    deletedCount++;
  }

  return deletedCount;
}

// ========== Failed Queue Management ==========

/**
 * Retry failed episode embeddings
 */
export async function retryFailedEpisodeEmbeddings(
  agentId: string,
  embedFn?: (episode: Episode) => Promise<void>,
): Promise<{ retried: number; success: number }> {
  const queue = getFailedQueue(agentId);
  const now = Date.now();
  const readyToRetry = queue.filter(
    (f) => now - f.lastAttempt >= RETRY_DELAY_MS && f.attempts < MAX_RETRY_ATTEMPTS,
  );

  if (readyToRetry.length === 0) {
    return { retried: 0, success: 0 };
  }

  log.info(`Retrying ${readyToRetry.length} failed episode embeddings...`);

  let success = 0;

  for (const failed of readyToRetry) {
    try {
      if (embedFn) {
        await embedFn(failed.episode);
      }

      const index = queue.indexOf(failed);
      if (index !== -1) {
        queue.splice(index, 1);
      }

      success++;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      queueFailedEmbedding(agentId, failed.episode, errorMsg);
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  log.info(`Retry complete: ${success}/${readyToRetry.length} succeeded`);
  return { retried: readyToRetry.length, success };
}

/**
 * Get failed embedding queue status
 */
export function getFailedEmbeddingQueueStatus(agentId: string): {
  count: number;
  episodes: string[];
} {
  const queue = getFailedQueue(agentId);
  return {
    count: queue.length,
    episodes: queue.map((f) => f.episode.id),
  };
}

/**
 * Add to failed embedding queue (for external use)
 */
export function addToFailedEmbeddingQueue(agentId: string, episode: Episode, error: string): void {
  queueFailedEmbedding(agentId, episode, error);
}

// ========== Episode Embedding Helpers ==========

/**
 * Get episode embedding path identifier
 */
export function getEpisodeEmbeddingPath(episodeId: string): string {
  return `episode:${episodeId}`;
}

/**
 * Check if path is an episode embedding path
 */
export function isEpisodeEmbeddingPath(pathStr: string): boolean {
  return pathStr.startsWith("episode:");
}

/**
 * Extract episode ID from embedding path
 */
export function extractEpisodeIdFromPath(pathStr: string): string | null {
  if (!isEpisodeEmbeddingPath(pathStr)) {
    return null;
  }
  return pathStr.replace("episode:", "");
}

// ========== Run Result Integration ==========

/**
 * Parameters for creating episode from run result
 */
export interface CreateEpisodeFromRunParams {
  workspaceDir: string;
  sessionId?: string;
  agentId?: string;
  prompt: string;
  success: boolean;
  aborted?: boolean;
  timedOut?: boolean;
  durationMs?: number;
  toolsUsed?: Array<{ toolName: string; meta?: string }>;
  filesInvolved?: string[];
  errorMessage?: string;
  userFeedback?: string;
  /** First ~200 chars of assistant's final reply text */
  assistantSummary?: string;
}

/**
 * Clean up raw prompt text for episode event field:
 * - Strip [message_id: ...] tags
 * - Strip leading/trailing whitespace
 * - Truncate to maxLen
 */
function cleanEventText(raw: string, maxLen = 200): string {
  let text = raw
    .replace(/\[message_id:\s*[^\]]*\]/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length > maxLen) {
    text = text.slice(0, maxLen) + "...";
  }
  return text;
}

/**
 * Extract file paths from tool metas more aggressively.
 * Looks for common patterns: path=..., file=..., /Users/..., ./..., ~/...
 */
function extractFilesFromToolMetas(
  toolsUsed?: Array<{ toolName: string; meta?: string }>,
): string[] {
  if (!toolsUsed) return [];
  const files = new Set<string>();

  for (const tool of toolsUsed) {
    if (!tool.meta) continue;

    // Pattern 1: path:"..." or file:"..." (with quotes)
    const quotedMatches = tool.meta.matchAll(/(?:path|file|filePath)[:\s]*["']([^"']+)["']/gi);
    for (const m of quotedMatches) {
      if (m[1] && !m[1].startsWith("http")) files.add(m[1]);
    }

    // Pattern 2: path:value or file:value (no quotes, until whitespace/comma)
    const unquotedMatches = tool.meta.matchAll(/(?:path|file|filePath)[:\s]*([^\s,"']+)/gi);
    for (const m of unquotedMatches) {
      if (m[1] && !m[1].startsWith("http") && m[1].includes("/")) files.add(m[1]);
    }

    // Pattern 3: absolute paths /Users/... or /tmp/... or ~/...
    const absMatches = tool.meta.matchAll(/(?:\/Users\/|\/tmp\/|~\/)[^\s,"')]+/g);
    for (const m of absMatches) {
      files.add(m[0]);
    }

    // Pattern 4: relative paths ./...
    const relMatches = tool.meta.matchAll(/\.\/[^\s,"')]+/g);
    for (const m of relMatches) {
      files.add(m[0]);
    }
  }

  return Array.from(files);
}

/**
 * Create and record episode from run result
 */
export function createEpisodeFromRunResult(params: CreateEpisodeFromRunParams): Episode | null {
  try {
    let outcome: "success" | "partial" | "failed" = "success";
    if (!params.success) {
      outcome = params.aborted ? "partial" : "failed";
    }

    const toolsUsed = params.toolsUsed?.map((t) => t.toolName) || [];

    const filesFromTools: string[] = [];
    if (params.toolsUsed) {
      for (const tool of params.toolsUsed) {
        if (tool.meta) {
          const pathMatches = tool.meta.match(/(?:path|file)[:\s]*["']?([^"'\s,]+)/gi);
          if (pathMatches) {
            for (const match of pathMatches) {
              const pathValue = match
                .replace(/^(?:path|file)[:\s]*["']?/i, "")
                .replace(/["']$/, "");
              if (pathValue && !pathValue.startsWith("http")) {
                filesFromTools.push(pathValue);
              }
            }
          }
        }
      }
    }

    // Use improved file extraction from tool metas
    const filesFromMetaImproved = extractFilesFromToolMetas(params.toolsUsed);
    const allFiles = [
      ...(params.filesInvolved || []),
      ...filesFromTools,
      ...filesFromMetaImproved,
    ].filter((f, i, arr) => arr.indexOf(f) === i);

    // Clean event text: strip message_id tags, trim, truncate
    const event = cleanEventText(params.prompt);

    const actions: string[] = [];
    // Deduplicate tool names for readability
    const uniqueTools = [...new Set(toolsUsed)];
    if (uniqueTools.length > 0) {
      actions.push(`Tools: ${uniqueTools.join(", ")}`);
    }
    if (params.aborted) {
      actions.push("Task aborted");
    }
    if (params.timedOut) {
      actions.push("Task timed out");
    }
    if (params.errorMessage) {
      actions.push(`Error: ${params.errorMessage.slice(0, 100)}`);
    }
    // Include assistant response summary for better searchability
    if (params.assistantSummary) {
      actions.push(`Response: ${params.assistantSummary.slice(0, 300)}`);
    }

    return recordEpisode(params.workspaceDir, {
      event,
      actions,
      files: allFiles,
      outcome,
      duration: params.durationMs,
      toolsUsed,
      sessionId: params.sessionId,
      agentId: params.agentId,
      userFeedback: params.userFeedback,
      emotionalContext: params.aborted ? "Aborted" : params.timedOut ? "Timed out" : undefined,
    });
  } catch (error) {
    log.error(`Failed to create episode from run result: ${error}`);
    return null;
  }
}

/**
 * Episode recorder configuration
 */
export interface EpisodeRecorderConfig {
  workspaceDir: string;
  agentId?: string;
  sessionId?: string;
  enabled?: boolean;
}

/**
 * Create an episode recorder
 */
export function createEpisodeRecorder(config: EpisodeRecorderConfig) {
  const startTime = Date.now();
  const toolsUsed: Array<{ toolName: string; meta?: string }> = [];
  const filesInvolved: string[] = [];
  let prompt = "";

  return {
    setPrompt(userPrompt: string) {
      prompt = userPrompt;
    },

    recordTool(toolName: string, meta?: string) {
      toolsUsed.push({ toolName, meta });
    },

    recordFile(filePath: string) {
      if (!filesInvolved.includes(filePath)) {
        filesInvolved.push(filePath);
      }
    },

    finish(result: {
      success: boolean;
      aborted?: boolean;
      timedOut?: boolean;
      errorMessage?: string;
      userFeedback?: string;
    }): Episode | null {
      if (config.enabled === false) {
        return null;
      }

      return createEpisodeFromRunResult({
        workspaceDir: config.workspaceDir,
        sessionId: config.sessionId,
        agentId: config.agentId,
        prompt,
        success: result.success,
        aborted: result.aborted,
        timedOut: result.timedOut,
        durationMs: Date.now() - startTime,
        toolsUsed,
        filesInvolved,
        errorMessage: result.errorMessage,
        userFeedback: result.userFeedback,
      });
    },
  };
}
