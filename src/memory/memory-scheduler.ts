/**
 * Memory Scheduler
 *
 * Manages memory system scheduled tasks:
 * - Startup tasks: retry failed embeddings
 * - Hourly tasks: cleanup old episodes, cleanup low-importance memories
 * - Daily tasks: run memory consolidation
 *
 * Note: This is a per-agent scheduler, each agent needs independent initialization
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  cleanupOldEpisodes,
  retryFailedEpisodeEmbeddings,
  type Episode,
} from "./episode-memory.js";
import {
  cleanupLowImportanceMemories,
  runMemoryConsolidation,
  shouldRunConsolidation,
} from "./memory-consolidation.js";

const log = createSubsystemLogger("memory-scheduler");

// ========== Type Definitions ==========

/**
 * Scheduler configuration
 */
export interface MemorySchedulerConfig {
  /** Agent ID */
  agentId: string;
  /** Workspace directory */
  workspaceDir: string;
  /** Startup delay (ms), default 30 seconds */
  startupDelay?: number;
  /** Hourly task interval (ms), default 1 hour */
  hourlyInterval?: number;
  /** Daily task interval (ms), default 24 hours */
  dailyInterval?: number;
  /** Episode embedding function (optional) */
  embedEpisodeFn?: (episode: Episode) => Promise<void>;
  /** Episodes retention months, default 6 */
  keepEpisodesMonths?: number;
  /** Low importance cleanup threshold, default 1 */
  lowImportanceThreshold?: number;
  /** Low importance max retention days, default 30 */
  lowImportanceMaxDays?: number;
}

/**
 * Scheduler status
 */
export interface SchedulerStatus {
  agentId: string;
  workspaceDir: string;
  initialized: boolean;
  hourlyTaskActive: boolean;
  dailyTaskActive: boolean;
  lastStartupRun?: number;
  lastHourlyRun?: number;
  lastDailyRun?: number;
}

/**
 * Task execution result
 */
export interface TaskResult {
  task: string;
  success: boolean;
  message?: string;
  details?: Record<string, unknown>;
}

// ========== Constants ==========

const DEFAULT_STARTUP_DELAY = 30 * 1000; // 30 seconds
const DEFAULT_HOURLY_INTERVAL = 60 * 60 * 1000; // 1 hour
const DEFAULT_DAILY_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

// ========== Scheduler Instance Management ==========

// Store scheduler instances by agentId
const schedulers = new Map<string, MemoryScheduler>();

/**
 * Get or create scheduler instance
 */
export function getMemoryScheduler(config: MemorySchedulerConfig): MemoryScheduler {
  let scheduler = schedulers.get(config.agentId);
  if (!scheduler) {
    scheduler = new MemoryScheduler(config);
    schedulers.set(config.agentId, scheduler);
  }
  return scheduler;
}

/**
 * Get existing scheduler instance
 */
export function getExistingScheduler(agentId: string): MemoryScheduler | null {
  return schedulers.get(agentId) || null;
}

/**
 * Remove scheduler instance
 */
export function removeScheduler(agentId: string): void {
  const scheduler = schedulers.get(agentId);
  if (scheduler) {
    scheduler.stop();
    schedulers.delete(agentId);
  }
}

/**
 * Stop all schedulers
 */
export function stopAllSchedulers(): void {
  for (const scheduler of schedulers.values()) {
    scheduler.stop();
  }
  schedulers.clear();
}

// ========== Scheduler Class ==========

/**
 * Memory Scheduler
 */
export class MemoryScheduler {
  private readonly agentId: string;
  private readonly workspaceDir: string;
  private readonly config: Required<Omit<MemorySchedulerConfig, "embedEpisodeFn">> & {
    embedEpisodeFn?: (episode: Episode) => Promise<void>;
  };

  private isInitialized = false;
  private hourlyTimer: ReturnType<typeof setInterval> | null = null;
  private dailyTimer: ReturnType<typeof setInterval> | null = null;

  private lastStartupRun?: number;
  private lastHourlyRun?: number;
  private lastDailyRun?: number;

  /**
   * Check if scheduler is initialized
   */
  isRunning(): boolean {
    return this.isInitialized;
  }

  constructor(config: MemorySchedulerConfig) {
    this.agentId = config.agentId;
    this.workspaceDir = config.workspaceDir;
    this.config = {
      agentId: config.agentId,
      workspaceDir: config.workspaceDir,
      startupDelay: config.startupDelay ?? DEFAULT_STARTUP_DELAY,
      hourlyInterval: config.hourlyInterval ?? DEFAULT_HOURLY_INTERVAL,
      dailyInterval: config.dailyInterval ?? DEFAULT_DAILY_INTERVAL,
      embedEpisodeFn: config.embedEpisodeFn,
      keepEpisodesMonths: config.keepEpisodesMonths ?? 6,
      lowImportanceThreshold: config.lowImportanceThreshold ?? 1,
      lowImportanceMaxDays: config.lowImportanceMaxDays ?? 30,
    };
  }

  /**
   * Initialize scheduler
   */
  async init(): Promise<void> {
    if (this.isInitialized) {
      log.debug(`Scheduler for ${this.agentId} already initialized, skipping`);
      return;
    }

    log.info(`Initializing scheduler for agent: ${this.agentId}`);
    this.isInitialized = true;

    // Delayed startup tasks
    setTimeout(async () => {
      await this.runStartupTasks();
    }, this.config.startupDelay);

    // Set up scheduled tasks
    this.setupScheduledTasks();

    log.info(`Scheduler for ${this.agentId} initialized successfully`);
  }

  /**
   * Stop scheduler
   */
  stop(): void {
    log.info(`Stopping scheduler for agent: ${this.agentId}`);

    if (this.hourlyTimer) {
      clearInterval(this.hourlyTimer);
      this.hourlyTimer = null;
    }

    if (this.dailyTimer) {
      clearInterval(this.dailyTimer);
      this.dailyTimer = null;
    }

    this.isInitialized = false;
    log.info(`Scheduler for ${this.agentId} stopped`);
  }

  /**
   * Get scheduler status
   */
  getStatus(): SchedulerStatus {
    return {
      agentId: this.agentId,
      workspaceDir: this.workspaceDir,
      initialized: this.isInitialized,
      hourlyTaskActive: this.hourlyTimer !== null,
      dailyTaskActive: this.dailyTimer !== null,
      lastStartupRun: this.lastStartupRun,
      lastHourlyRun: this.lastHourlyRun,
      lastDailyRun: this.lastDailyRun,
    };
  }

  /**
   * Run startup tasks
   */
  private async runStartupTasks(): Promise<TaskResult[]> {
    log.info(`Running startup tasks for ${this.agentId}...`);
    const results: TaskResult[] = [];

    try {
      // 1. Retry failed episode embeddings
      const episodeResult = await retryFailedEpisodeEmbeddings(
        this.agentId,
        this.config.embedEpisodeFn,
      );
      results.push({
        task: "retryEpisodeEmbeddings",
        success: true,
        details: episodeResult,
      });
      log.info(
        `Retried episode embeddings: ${episodeResult.success}/${episodeResult.retried} succeeded`,
      );

      this.lastStartupRun = Date.now();
      log.info(`Startup tasks for ${this.agentId} completed`);
    } catch (error) {
      log.error(`Startup tasks for ${this.agentId} failed: ${String(error)}`);
      results.push({
        task: "startup",
        success: false,
        message: String(error),
      });
    }

    return results;
  }

  /**
   * Set up scheduled tasks
   */
  private setupScheduledTasks(): void {
    // Hourly cleanup tasks
    this.hourlyTimer = setInterval(async () => {
      await this.runHourlyTasks();
    }, this.config.hourlyInterval);

    // Daily consolidation tasks
    this.dailyTimer = setInterval(async () => {
      await this.runDailyTasks();
    }, this.config.dailyInterval);
  }

  /**
   * Hourly tasks
   */
  async runHourlyTasks(): Promise<TaskResult[]> {
    log.info(`Running hourly tasks for ${this.agentId}...`);
    const results: TaskResult[] = [];

    try {
      // 1. Cleanup old episodes
      const deletedEpisodes = cleanupOldEpisodes(this.workspaceDir, this.config.keepEpisodesMonths);
      results.push({
        task: "cleanupOldEpisodes",
        success: true,
        details: { deleted: deletedEpisodes },
      });
      if (deletedEpisodes > 0) {
        log.info(`Cleaned up ${deletedEpisodes} old episode stores`);
      }

      // 2. Cleanup low importance memories
      const removed = cleanupLowImportanceMemories(
        this.workspaceDir,
        this.config.lowImportanceThreshold,
        this.config.lowImportanceMaxDays,
      );
      results.push({
        task: "cleanupLowImportanceMemories",
        success: true,
        details: { removed },
      });
      if (removed > 0) {
        log.info(`Cleaned up ${removed} low-importance memories`);
      }

      // 3. Retry failed embeddings
      const episodeResult = await retryFailedEpisodeEmbeddings(
        this.agentId,
        this.config.embedEpisodeFn,
      );
      if (episodeResult.retried > 0) {
        results.push({
          task: "retryEpisodeEmbeddings",
          success: true,
          details: episodeResult,
        });
        log.info(
          `Hourly retry: ${episodeResult.success}/${episodeResult.retried} episode embeddings succeeded`,
        );
      }

      this.lastHourlyRun = Date.now();
      log.info(`Hourly tasks for ${this.agentId} completed`);
    } catch (error) {
      log.error(`Hourly tasks for ${this.agentId} failed: ${String(error)}`);
      results.push({
        task: "hourly",
        success: false,
        message: String(error),
      });
    }

    return results;
  }

  /**
   * Daily tasks
   */
  async runDailyTasks(): Promise<TaskResult[]> {
    log.info(`Running daily tasks for ${this.agentId}...`);
    const results: TaskResult[] = [];

    try {
      // 1. Run memory consolidation (check and promote high-frequency memories to MEMORY.md)
      if (shouldRunConsolidation(this.workspaceDir)) {
        const consolidationResult = runMemoryConsolidation(this.workspaceDir);
        results.push({
          task: "memoryConsolidation",
          success: true,
          details: consolidationResult,
        });
        log.info(
          `Memory consolidation: ${consolidationResult.promoted}/${consolidationResult.total} promoted`,
        );
      }

      this.lastDailyRun = Date.now();
      log.info(`Daily tasks for ${this.agentId} completed`);
    } catch (error) {
      log.error(`Daily tasks for ${this.agentId} failed: ${String(error)}`);
      results.push({
        task: "daily",
        success: false,
        message: String(error),
      });
    }

    return results;
  }

  /**
   * Manually trigger maintenance check
   */
  async triggerMaintenanceCheck(): Promise<TaskResult[]> {
    const results: TaskResult[] = [];

    try {
      if (shouldRunConsolidation(this.workspaceDir)) {
        log.info(`Triggering memory consolidation for ${this.agentId}...`);
        const result = runMemoryConsolidation(this.workspaceDir);
        results.push({
          task: "memoryConsolidation",
          success: true,
          details: result,
        });
      }
    } catch (error) {
      log.error(`Maintenance check for ${this.agentId} failed: ${String(error)}`);
      results.push({
        task: "maintenanceCheck",
        success: false,
        message: String(error),
      });
    }

    return results;
  }

  /**
   * Run all tasks now (for testing or manual trigger)
   */
  async runAllTasksNow(): Promise<{
    startup: TaskResult[];
    hourly: TaskResult[];
    daily: TaskResult[];
  }> {
    const startup = await this.runStartupTasks();
    const hourly = await this.runHourlyTasks();
    const daily = await this.runDailyTasks();

    return { startup, hourly, daily };
  }
}

/**
 * Convenience function to create and initialize scheduler
 */
export async function createAndInitScheduler(
  config: MemorySchedulerConfig,
): Promise<MemoryScheduler> {
  const scheduler = getMemoryScheduler(config);
  await scheduler.init();
  return scheduler;
}
