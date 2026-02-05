export type { MemoryIndexManager, MemorySearchResult } from "./manager.js";
export { getMemorySearchManager, type MemorySearchManagerResult } from "./search-manager.js";

// Episodic memory
export {
  recordEpisode,
  getAllEpisodes,
  getRecentEpisodes,
  getEpisodesCount,
  searchEpisodesByKeyword,
  formatEpisodesForContext,
  createEpisodeFromRunResult,
  cleanupOldEpisodes,
  type Episode,
} from "./episode-memory.js";

// Memory consolidation
export {
  loadMemoryIndex,
  addMemoryItem,
  onMemoryRecalled,
  onMemoriesRecalled,
  searchMemoryItems,
  getMemoryStats,
  runMemoryConsolidation,
  shouldRunConsolidation,
  type MemoryItem,
  type MemoryIndex,
} from "./memory-consolidation.js";

// Memory scheduler
export {
  getMemoryScheduler,
  createAndInitScheduler,
  stopAllSchedulers,
  type MemorySchedulerConfig,
} from "./memory-scheduler.js";
