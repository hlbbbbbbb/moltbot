import { Type } from "@sinclair/typebox";

import type { ClawdbotConfig } from "../../config/config.js";
import {
  getMemorySearchManager,
  searchEpisodesByKeyword,
  getRecentEpisodes,
  getEpisodesCount,
  getMemoryStats,
  loadMemoryIndex,
  onMemoriesRecalled,
} from "../../memory/index.js";
import { resolveSessionAgentId, resolveAgentWorkspaceDir } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const MemorySearchSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number()),
  minScore: Type.Optional(Type.Number()),
});

const MemoryGetSchema = Type.Object({
  path: Type.String(),
  from: Type.Optional(Type.Number()),
  lines: Type.Optional(Type.Number()),
});

export function createMemorySearchTool(options: {
  config?: ClawdbotConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) return null;
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  if (!resolveMemorySearchConfig(cfg, agentId)) return null;
  return {
    label: "Memory Search",
    name: "memory_search",
    description:
      "Mandatory recall step: semantically search MEMORY.md + memory/*.md (and optional session transcripts) before answering questions about prior work, decisions, dates, people, preferences, or todos; returns top snippets with path + lines.",
    parameters: MemorySearchSchema,
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });
      const maxResults = readNumberParam(params, "maxResults");
      const minScore = readNumberParam(params, "minScore");
      const { manager, error } = await getMemorySearchManager({
        cfg,
        agentId,
      });
      if (!manager) {
        return jsonResult({ results: [], disabled: true, error });
      }
      try {
        const results = await manager.search(query, {
          maxResults,
          minScore,
          sessionKey: options.agentSessionKey,
        });
        const status = manager.status();
        return jsonResult({
          results,
          provider: status.provider,
          model: status.model,
          fallback: status.fallback,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ results: [], disabled: true, error: message });
      }
    },
  };
}

export function createMemoryGetTool(options: {
  config?: ClawdbotConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) return null;
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  if (!resolveMemorySearchConfig(cfg, agentId)) return null;
  return {
    label: "Memory Get",
    name: "memory_get",
    description:
      "Safe snippet read from MEMORY.md or memory/*.md with optional from/lines; use after memory_search to pull only the needed lines and keep context small.",
    parameters: MemoryGetSchema,
    execute: async (_toolCallId, params) => {
      const relPath = readStringParam(params, "path", { required: true });
      const from = readNumberParam(params, "from", { integer: true });
      const lines = readNumberParam(params, "lines", { integer: true });
      const { manager, error } = await getMemorySearchManager({
        cfg,
        agentId,
      });
      if (!manager) {
        return jsonResult({ path: relPath, text: "", disabled: true, error });
      }
      try {
        const result = await manager.readFile({
          relPath,
          from: from ?? undefined,
          lines: lines ?? undefined,
        });
        return jsonResult(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ path: relPath, text: "", disabled: true, error: message });
      }
    },
  };
}

// ========== Episode Search Tool ==========

const EpisodeSearchSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number()),
});

/**
 * Create episode search tool
 * Search episodic memory (specific task event records)
 */
export function createEpisodeSearchTool(options: {
  config?: ClawdbotConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) return null;
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);

  return {
    label: "Episode Search",
    name: "episode_search",
    description:
      "Search episodic memory (task events) for past actions, file operations, and outcomes. Use when asking about 'what did I do', 'when did I work on X', or specific past tasks.",
    parameters: EpisodeSearchSchema,
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });
      const maxResults = readNumberParam(params, "maxResults") ?? 5;

      try {
        const results = searchEpisodesByKeyword(workspaceDir, query, maxResults);

        // Track recall for memory consolidation
        if (results.length > 0) {
          try {
            const memIndex = loadMemoryIndex(workspaceDir);
            const recalledIds = results
              .map((r) => {
                const item = memIndex.items.find((i) => i.source === `episode:${r.episode.id}`);
                return item?.id;
              })
              .filter((id): id is string => !!id);
            if (recalledIds.length > 0) {
              onMemoriesRecalled(workspaceDir, recalledIds);
            }
          } catch {
            // Ignore recall tracking errors
          }
        }

        // Format results
        const formattedResults = results.map((r) => ({
          score: r.score,
          event: r.episode.event,
          outcome: r.episode.outcome,
          timestamp: new Date(r.episode.timestamp).toISOString(),
          files: r.episode.files,
          actions: r.episode.actions,
          toolsUsed: r.episode.toolsUsed,
          userFeedback: r.episode.userFeedback,
        }));

        return jsonResult({
          results: formattedResults,
          totalEpisodes: getEpisodesCount(workspaceDir),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ results: [], error: message });
      }
    },
  };
}

// ========== Memory Overview Tool ==========

const MemoryOverviewSchema = Type.Object({
  includeEpisodes: Type.Optional(Type.Boolean()),
  includeStats: Type.Optional(Type.Boolean()),
  recentDays: Type.Optional(Type.Number()),
});

/**
 * Create memory overview tool
 * Get overall status and recent content of the memory system
 */
export function createMemoryOverviewTool(options: {
  config?: ClawdbotConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) return null;
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);

  return {
    label: "Memory Overview",
    name: "memory_overview",
    description:
      "Get an overview of the memory system: recent episodes and memory statistics. Useful for understanding what's been remembered and what's available.",
    parameters: MemoryOverviewSchema,
    execute: async (_toolCallId, params) => {
      const includeEpisodes = params.includeEpisodes !== false;
      const includeStats = params.includeStats !== false;
      const recentDays = readNumberParam(params, "recentDays") ?? 7;

      try {
        const result: Record<string, unknown> = {};

        // Episodes overview
        if (includeEpisodes) {
          const recentEps = getRecentEpisodes(workspaceDir, recentDays);
          result.episodes = {
            total: getEpisodesCount(workspaceDir),
            recentDays,
            recentCount: recentEps.length,
            recent: recentEps.slice(0, 5).map((ep) => ({
              event: ep.event.slice(0, 100),
              outcome: ep.outcome,
              timestamp: new Date(ep.timestamp).toISOString(),
              filesCount: ep.files.length,
            })),
          };
        }

        // Memory consolidation stats
        if (includeStats) {
          const stats = getMemoryStats(workspaceDir);
          result.consolidation = {
            totalItems: stats.total,
            promotedItems: stats.promoted,
            byType: stats.byType,
            avgImportance: Math.round(stats.avgImportance * 100) / 100,
          };
        }

        return jsonResult(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: message });
      }
    },
  };
}

/**
 * Get all memory-related tools
 */
export function createAllMemoryTools(options: {
  config?: ClawdbotConfig;
  agentSessionKey?: string;
}): AnyAgentTool[] {
  const tools: AnyAgentTool[] = [];

  const searchTool = createMemorySearchTool(options);
  if (searchTool) tools.push(searchTool);

  const getTool = createMemoryGetTool(options);
  if (getTool) tools.push(getTool);

  const episodeTool = createEpisodeSearchTool(options);
  if (episodeTool) tools.push(episodeTool);

  const overviewTool = createMemoryOverviewTool(options);
  if (overviewTool) tools.push(overviewTool);

  return tools;
}
