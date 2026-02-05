/**
 * Memory Consolidation System
 *
 * Implements importance evaluation, recall tracking, and automatic promotion.
 * - Track recall count and time for each memory item
 * - Calculate effective importance (with time decay)
 * - Automatically promote high-frequency memories to MEMORY.md
 *
 * Storage path: workspace/memory-index.json
 */

import fsSync from "node:fs";
import path from "node:path";

import { createSubsystemLogger } from "../logging/subsystem.js";
import { ensureDir } from "./internal.js";

const log = createSubsystemLogger("memory-consolidation");

// ========== Constants ==========

const MEMORY_INDEX_FILE = "memory-index.json";
const MEMORY_FILE = "MEMORY.md";

// Promotion rules
const PROMOTION_RECALL_THRESHOLD = 3; // Recall count threshold
const PROMOTION_DAYS_WINDOW = 7; // Statistics window (days)
const DECAY_RATE = 0.1; // ~10% decay per day
const RECALL_BONUS_FACTOR = 0.5; // Recall bonus coefficient

// ========== Type Definitions ==========

/**
 * Memory item types
 */
export type MemoryItemType =
  | "keyFact"
  | "episode"
  | "preference"
  | "lesson"
  | "file"
  | "credential";

/**
 * Memory item data structure
 */
export interface MemoryItem {
  id: string;
  content: string;
  type: MemoryItemType;
  importance: number; // Initial importance 1-10
  recallCount: number; // Times retrieved/referenced
  lastRecalled: number; // Last retrieval timestamp
  createdAt: number; // Creation time
  source: string; // Source (session ID, part number, etc.)
  context?: string; // Context description
  promoted?: boolean; // Whether promoted to MEMORY.md
  promotedAt?: number; // Promotion time
  agentId?: string; // Agent ID
}

/**
 * Memory index storage structure
 */
export interface MemoryIndex {
  version: number;
  items: MemoryItem[];
  lastConsolidation: number; // Last consolidation time
}

// ========== Utility Functions ==========

/**
 * Get memory index file path
 */
function getMemoryIndexPath(workspaceDir: string): string {
  return path.join(workspaceDir, MEMORY_INDEX_FILE);
}

/**
 * Get MEMORY.md file path
 */
function getMemoryFilePath(workspaceDir: string): string {
  return path.join(workspaceDir, MEMORY_FILE);
}

/**
 * Generate memory item ID
 */
function generateMemoryId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substr(2, 5);
  return `mem-${timestamp}-${random}`;
}

// ========== Core Functions ==========

/**
 * Load memory index
 */
export function loadMemoryIndex(workspaceDir: string): MemoryIndex {
  const indexPath = getMemoryIndexPath(workspaceDir);

  if (fsSync.existsSync(indexPath)) {
    try {
      const content = fsSync.readFileSync(indexPath, "utf-8");
      return JSON.parse(content);
    } catch {
      log.warn("Failed to load memory index, creating new one");
    }
  }

  return {
    version: 1,
    items: [],
    lastConsolidation: 0,
  };
}

/**
 * Save memory index
 */
export function saveMemoryIndex(workspaceDir: string, index: MemoryIndex): void {
  ensureDir(workspaceDir);
  const indexPath = getMemoryIndexPath(workspaceDir);
  fsSync.writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf-8");
}

/**
 * Calculate effective importance (with time decay and recall frequency)
 *
 * Formula: effective = base * decay + recallBonus
 * - decay: Exponential decay based on last recall time
 * - recallBonus: Logarithmic bonus based on recall count
 */
export function getEffectiveImportance(item: MemoryItem): number {
  const daysSinceRecall = (Date.now() - item.lastRecalled) / (24 * 60 * 60 * 1000);
  const decayFactor = Math.exp(-DECAY_RATE * daysSinceRecall);
  const recallBonus = Math.log(item.recallCount + 1) * RECALL_BONUS_FACTOR;

  return item.importance * decayFactor + recallBonus;
}

/**
 * Add or update memory item
 */
export function addMemoryItem(
  workspaceDir: string,
  item: Omit<MemoryItem, "id" | "recallCount" | "lastRecalled" | "createdAt">,
): MemoryItem {
  const index = loadMemoryIndex(workspaceDir);

  // Check if same content already exists
  const existing = index.items.find((i) => i.content === item.content && i.type === item.type);

  if (existing) {
    // Update existing memory's importance (take the higher value)
    existing.importance = Math.max(existing.importance, item.importance);
    existing.lastRecalled = Date.now();
    existing.recallCount += 1;
    saveMemoryIndex(workspaceDir, index);
    log.debug(`Updated existing memory: ${existing.id}`);
    return existing;
  }

  // Create new memory
  const newItem: MemoryItem = {
    ...item,
    id: generateMemoryId(),
    recallCount: 0,
    lastRecalled: Date.now(),
    createdAt: Date.now(),
  };

  index.items.push(newItem);
  saveMemoryIndex(workspaceDir, index);

  log.debug(`Added new memory: ${newItem.id}`);
  return newItem;
}

/**
 * Record memory recall (called when retrieved)
 */
export function onMemoryRecalled(workspaceDir: string, itemId: string): void {
  const index = loadMemoryIndex(workspaceDir);
  const item = index.items.find((i) => i.id === itemId);

  if (item) {
    item.recallCount += 1;
    item.lastRecalled = Date.now();
    saveMemoryIndex(workspaceDir, index);
    log.debug(`Memory recalled: ${itemId} (count: ${item.recallCount})`);
  }
}

/**
 * Batch record memory recalls
 */
export function onMemoriesRecalled(workspaceDir: string, itemIds: string[]): void {
  if (itemIds.length === 0) return;

  const index = loadMemoryIndex(workspaceDir);
  const now = Date.now();

  for (const itemId of itemIds) {
    const item = index.items.find((i) => i.id === itemId);
    if (item) {
      item.recallCount += 1;
      item.lastRecalled = now;
    }
  }

  saveMemoryIndex(workspaceDir, index);
  log.debug(`Batch recalled ${itemIds.length} memories`);
}

/**
 * Search memory items (keyword matching)
 */
export function searchMemoryItems(
  workspaceDir: string,
  query: string,
  topK: number = 10,
): MemoryItem[] {
  const index = loadMemoryIndex(workspaceDir);
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/);

  const scored = index.items.map((item) => {
    const searchText = `${item.content} ${item.context || ""}`.toLowerCase();
    let matchScore = 0;

    for (const word of queryWords) {
      if (searchText.includes(word)) {
        matchScore += 1;
      }
    }

    const effectiveImportance = getEffectiveImportance(item);
    const totalScore = (matchScore / queryWords.length) * 0.7 + (effectiveImportance / 10) * 0.3;

    return { item, score: totalScore };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((s) => s.item);
}

/**
 * Find promotion candidates (recalled M+ times in N days)
 */
export function findPromotionCandidates(
  workspaceDir: string,
  recallThreshold: number = PROMOTION_RECALL_THRESHOLD,
  daysWindow: number = PROMOTION_DAYS_WINDOW,
): MemoryItem[] {
  const index = loadMemoryIndex(workspaceDir);
  const cutoff = Date.now() - daysWindow * 24 * 60 * 60 * 1000;

  return index.items.filter(
    (item) => !item.promoted && item.recallCount >= recallThreshold && item.createdAt >= cutoff,
  );
}

/**
 * Read MEMORY.md content
 */
export function readMemoryFile(workspaceDir: string): string {
  const filePath = getMemoryFilePath(workspaceDir);
  if (fsSync.existsSync(filePath)) {
    return fsSync.readFileSync(filePath, "utf-8");
  }
  return "";
}

/**
 * Append content to MEMORY.md
 */
export function appendToMemoryFile(workspaceDir: string, content: string): void {
  const filePath = getMemoryFilePath(workspaceDir);
  fsSync.appendFileSync(filePath, content, "utf-8");
}

/**
 * Promote memory to MEMORY.md
 * With deduplication check to avoid duplicate writes
 */
export function promoteToLongTermMemory(workspaceDir: string, item: MemoryItem): boolean {
  // Read current MEMORY.md
  const memoryContent = readMemoryFile(workspaceDir);

  // Deduplication check
  const escaped = item.content.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const contentPattern = new RegExp(escaped, "i");

  if (contentPattern.test(memoryContent)) {
    log.debug(`Item already exists in MEMORY.md, skipping: ${item.content.slice(0, 50)}...`);
    return false;
  }

  // Determine section to add to
  let section = "## Important Events";
  if (item.type === "preference") {
    section = "## User Preferences";
  } else if (item.type === "lesson") {
    section = "## Lessons Learned";
  } else if (item.type === "file" || item.type === "credential") {
    section = "## Important Information";
  }

  // Format memory content
  const date = new Date(item.createdAt).toLocaleDateString();
  const context = item.context ? ` (${item.context})` : "";
  const newEntry = `- [${date}] [${item.type}] ${item.content}${context}`;

  // Append to MEMORY.md
  const appendContent = `\n\n${section}\n\n${newEntry}`;
  appendToMemoryFile(workspaceDir, appendContent);

  log.info(`Promoted to MEMORY.md: ${item.content.slice(0, 50)}...`);

  return true;
}

/**
 * Run memory consolidation (check and execute promotions)
 */
export function runMemoryConsolidation(workspaceDir: string): {
  promoted: number;
  total: number;
} {
  log.info("Running consolidation...");

  const candidates = findPromotionCandidates(workspaceDir);
  let promotedCount = 0;

  for (const candidate of candidates) {
    try {
      const success = promoteToLongTermMemory(workspaceDir, candidate);

      if (success) {
        // Mark as promoted
        const index = loadMemoryIndex(workspaceDir);
        const item = index.items.find((i) => i.id === candidate.id);
        if (item) {
          item.promoted = true;
          item.promotedAt = Date.now();
          saveMemoryIndex(workspaceDir, index);
        }

        promotedCount++;
      }
    } catch (error) {
      log.error(`Failed to promote ${candidate.id}: ${error}`);
    }
  }

  // Update last consolidation time
  const index = loadMemoryIndex(workspaceDir);
  index.lastConsolidation = Date.now();
  saveMemoryIndex(workspaceDir, index);

  log.info(`Consolidation complete: ${promotedCount}/${candidates.length} promoted`);

  return {
    promoted: promotedCount,
    total: candidates.length,
  };
}

/**
 * Check if consolidation should run (at most once per day)
 */
export function shouldRunConsolidation(workspaceDir: string): boolean {
  const index = loadMemoryIndex(workspaceDir);
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

  return index.lastConsolidation < oneDayAgo;
}

/**
 * Import from KeyFact
 */
export function importFromKeyFact(
  workspaceDir: string,
  fact: { type: string; value: string; context?: string },
  source: string,
): MemoryItem {
  let memoryType: MemoryItemType = "keyFact";
  let importance = 5;

  switch (fact.type) {
    case "credential":
      memoryType = "credential";
      importance = 9;
      break;
    case "file":
      memoryType = "file";
      importance = 6;
      break;
    case "user_instruction":
      memoryType = "preference";
      importance = 8;
      break;
    case "deadline":
      importance = 8;
      break;
    case "person":
    case "number":
      importance = 5;
      break;
  }

  return addMemoryItem(workspaceDir, {
    content: fact.value,
    type: memoryType,
    importance,
    source,
    context: fact.context,
  });
}

/**
 * Get memory statistics
 */
export function getMemoryStats(workspaceDir: string): {
  total: number;
  promoted: number;
  byType: Record<string, number>;
  avgImportance: number;
} {
  const index = loadMemoryIndex(workspaceDir);

  const byType: Record<string, number> = {};
  let totalImportance = 0;

  for (const item of index.items) {
    byType[item.type] = (byType[item.type] || 0) + 1;
    totalImportance += getEffectiveImportance(item);
  }

  return {
    total: index.items.length,
    promoted: index.items.filter((i) => i.promoted).length,
    byType,
    avgImportance: index.items.length > 0 ? totalImportance / index.items.length : 0,
  };
}

/**
 * Cleanup low importance old memories
 */
export function cleanupLowImportanceMemories(
  workspaceDir: string,
  threshold: number = 1,
  maxAgeDays: number = 30,
): number {
  const index = loadMemoryIndex(workspaceDir);
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  const before = index.items.length;

  index.items = index.items.filter((item) => {
    // Keep promoted items
    if (item.promoted) return true;

    // Keep recently created items
    if (item.createdAt > cutoff) return true;

    // Keep high importance items
    const effectiveImportance = getEffectiveImportance(item);
    return effectiveImportance >= threshold;
  });

  const removed = before - index.items.length;

  if (removed > 0) {
    saveMemoryIndex(workspaceDir, index);
    log.info(`Cleaned up ${removed} low-importance memories`);
  }

  return removed;
}

/**
 * Get memory items by type
 */
export function getMemoryItemsByType(workspaceDir: string, type: MemoryItemType): MemoryItem[] {
  const index = loadMemoryIndex(workspaceDir);
  return index.items.filter((item) => item.type === type);
}

/**
 * Get recent memory items
 */
export function getRecentMemoryItems(
  workspaceDir: string,
  days: number = 7,
  limit: number = 20,
): MemoryItem[] {
  const index = loadMemoryIndex(workspaceDir);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  return index.items
    .filter((item) => item.createdAt >= cutoff)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

/**
 * Delete memory item
 */
export function deleteMemoryItem(workspaceDir: string, itemId: string): boolean {
  const index = loadMemoryIndex(workspaceDir);
  const itemIndex = index.items.findIndex((i) => i.id === itemId);

  if (itemIndex === -1) {
    return false;
  }

  index.items.splice(itemIndex, 1);
  saveMemoryIndex(workspaceDir, index);
  log.debug(`Deleted memory item: ${itemId}`);

  return true;
}
