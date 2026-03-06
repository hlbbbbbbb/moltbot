/**
 * Tool Result Disk Cache — stores full tool results to disk so the
 * agent can retrieve oversized outputs via a `read` tool call.
 *
 * Cache layout:  <cacheDir>/<sessionId>/<toolCallId>.txt
 */

import fs from "node:fs/promises";
import path from "node:path";

/**
 * Write a tool result to the disk cache.
 * Returns the absolute path to the cached file.
 */
export async function cacheToolResult(params: {
  content: string;
  toolCallId: string;
  sessionId: string;
  cacheDir: string;
}): Promise<string> {
  const dir = path.join(params.cacheDir, params.sessionId);
  await fs.mkdir(dir, { recursive: true });

  // Sanitize toolCallId for filesystem safety
  const safeId = params.toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = path.join(dir, `${safeId}.txt`);
  await fs.writeFile(filePath, params.content, "utf-8");
  return filePath;
}

/**
 * Read a previously cached tool result from disk.
 * Returns null if the file doesn't exist.
 */
export async function readCachedToolResult(cachePath: string): Promise<string | null> {
  try {
    return await fs.readFile(cachePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Remove cached tool results older than `maxAgeDays`.
 */
export async function cleanupExpiredCache(cacheDir: string, maxAgeDays: number): Promise<void> {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  let entries: string[];
  try {
    entries = await fs.readdir(cacheDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(cacheDir, entry);
    try {
      const stat = await fs.stat(entryPath);
      if (stat.isDirectory() && stat.mtimeMs < cutoff) {
        await fs.rm(entryPath, { recursive: true, force: true });
      }
    } catch {
      // Skip entries that can't be stat'd
    }
  }
}
