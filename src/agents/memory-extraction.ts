/**
 * Memory Extraction — automatically extract memorable items from user
 * conversation using pattern matching (no LLM calls, zero latency).
 *
 * Extracts: explicit "remember" requests, names/identities, preferences,
 * dates/deadlines, factual statements.
 *
 * Extracted items are written to the memory consolidation system with
 * high importance so they get promoted to MEMORY.md automatically.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory-extraction");

export type ExtractedMemory = {
  text: string;
  type: "keyFact" | "preference" | "reminder";
  importance: number; // 7-9
  source: string; // e.g. "user message"
};

// --- Pattern definitions ---

const REMEMBER_PATTERNS = [
  // Chinese
  /记住[：:]\s*(.{5,200})/,
  /记住(.{5,200})/,
  /记得(.{5,100})/,
  /不要忘记(.{5,200})/,
  // English
  /remember(?:\s+that)?[：:\s]+(.{5,200})/i,
  /don'?t forget[：:\s]+(.{5,200})/i,
  /keep in mind[：:\s]+(.{5,200})/i,
  /note that[：:\s]+(.{5,200})/i,
];

const NAME_PATTERNS = [
  // Chinese
  /我(?:的名字)?叫\s*([^\s，。,.]{2,20})/,
  /我是\s*([^\s，。,.]{2,20})/,
  // English
  /my name is\s+([A-Z][a-zA-Z\s]{1,30})/i,
  /(?:I'?m|I am)\s+([A-Z][a-zA-Z\s]{1,30})/i,
  /call me\s+([A-Z][a-zA-Z\s]{1,20})/i,
];

const PREFERENCE_PATTERNS = [
  // Chinese
  /我喜欢(.{3,100})/,
  /我(?:更)?偏好(.{3,100})/,
  /我(?:更)?倾向于?(.{3,100})/,
  /我不喜欢(.{3,100})/,
  // English
  /I (?:always |usually )?prefer\s+(.{3,100})/i,
  /I (?:really )?like\s+(.{3,100})/i,
  /I (?:really )?don'?t like\s+(.{3,100})/i,
  /always (?:use|do)\s+(.{3,100})/i,
  /never (?:use|do)\s+(.{3,100})/i,
];

const FACT_PATTERNS = [
  // Chinese
  /我住在(.{3,60})/,
  /我的地址是(.{5,100})/,
  /我的(?:邮箱|email)是\s*(\S{5,80})/,
  /我的(?:电话|手机|号码)是\s*(\S{5,30})/,
  /我在(.{2,60})(?:工作|上班|上学)/,
  // English
  /I live (?:in|at)\s+(.{3,60})/i,
  /my (?:email|address|phone) is\s+(\S{5,80})/i,
  /I work (?:at|for)\s+(.{3,60})/i,
];

const DATE_PATTERNS = [
  // Chinese
  /(?:截止|截至|deadline|到期|到)\s*(?:日期|时间)?[是为：:]\s*(.{5,50})/i,
  /(\d{4}[-/]\d{1,2}[-/]\d{1,2})\s*(?:之前|前|以前|before)/i,
  // English
  /deadline[:\s]+(.{5,50})/i,
  /due (?:date|by)[:\s]+(.{5,50})/i,
  /by\s+((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,?\s+\d{4})?)/i,
];

function extractFromPatterns(
  text: string,
  patterns: RegExp[],
  type: ExtractedMemory["type"],
  importance: number,
): ExtractedMemory[] {
  const results: ExtractedMemory[] = [];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const extracted = match[1].trim();
      // Avoid noise: skip very short or very long matches
      if (extracted.length >= 3 && extracted.length <= 200) {
        results.push({
          text: `${match[0].trim()}`,
          type,
          importance,
          source: "user message",
        });
      }
    }
  }
  return results;
}

/**
 * Extract memorable items from user messages.
 * Pure regex/heuristic — no LLM calls, runs synchronously and fast.
 */
export function extractMemorableItems(userMessages: string[]): ExtractedMemory[] {
  const all: ExtractedMemory[] = [];

  for (const text of userMessages) {
    if (!text || text.length < 5) continue;

    // Explicit "remember" requests — highest importance
    all.push(...extractFromPatterns(text, REMEMBER_PATTERNS, "keyFact", 9));

    // Names/identities
    all.push(...extractFromPatterns(text, NAME_PATTERNS, "keyFact", 8));

    // Preferences
    all.push(...extractFromPatterns(text, PREFERENCE_PATTERNS, "preference", 7));

    // Facts
    all.push(...extractFromPatterns(text, FACT_PATTERNS, "keyFact", 8));

    // Dates/deadlines
    all.push(...extractFromPatterns(text, DATE_PATTERNS, "reminder", 8));
  }

  // Deduplicate by text content
  const seen = new Set<string>();
  return all.filter((item) => {
    const key = item.text.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Process extracted memories and store them via the memory consolidation
 * system. Fire-and-forget — does not block the response pipeline.
 */
export async function processExtractedMemories(params: {
  userMessages: string[];
  storeMemoryFn: (text: string, type: string, importance: number) => Promise<void>;
}): Promise<void> {
  try {
    const items = extractMemorableItems(params.userMessages);
    if (items.length === 0) return;

    log.info(`Extracted ${items.length} memorable items from conversation`);

    for (const item of items) {
      try {
        await params.storeMemoryFn(item.text, item.type, item.importance);
      } catch (err) {
        log.warn(`Failed to store extracted memory: ${String(err)}`);
      }
    }
  } catch (err) {
    log.warn(`Memory extraction failed: ${String(err)}`);
  }
}
