/**
 * Structured summary prompts for anchored iterative compaction.
 *
 * Instead of regenerating a full summary each time, the system maintains a
 * persistent structured summary and merges only new increments into it.
 * This keeps each LLM call small and prevents "summary too large" failures.
 */

/** Prompt used for the first compaction (no prior structured summary exists). */
export const STRUCTURED_SUMMARY_PROMPT = [
  "Summarize this coding session into a structured format.",
  "Be concise but preserve all important details, decisions, and constraints.",
  "Output using this exact markdown format:\n",
  "## Goal",
  "[One sentence: the user's original request/objective]\n",
  "## Completed",
  "- [Each completed task or milestone as a bullet point]\n",
  "## Current State",
  "[1-2 sentences: where work stands right now]\n",
  "## Key Files",
  "- `path/to/file` — [brief role, e.g. modified to add X, read for reference]\n",
  "## Pending",
  "- [Open questions, decisions, or next steps (omit section if none)]",
].join("\n");

/** Prompt used for subsequent compactions (merge new messages into existing summary). */
export const INCREMENTAL_MERGE_PROMPT = [
  "You are updating a running session summary. You have two inputs:",
  "1. EXISTING SUMMARY — the structured summary from prior compaction(s)",
  "2. NEW MESSAGES — recent conversation messages since the last compaction\n",
  "Merge the new information into the existing summary:",
  "- Update Goal only if the user changed direction",
  "- Append new items to Completed",
  "- Replace Current State with the latest state",
  "- Merge Key Files (add new, keep relevant old ones, drop stale ones)",
  "- Update Pending to reflect current open items",
  "- Drop resolved items from Pending\n",
  "Output the updated summary in the same structured format.",
].join("\n");

/** Markers used to detect whether a previous summary is in structured format. */
const STRUCTURED_MARKERS = ["## Goal", "## Current State"] as const;

/**
 * Check whether `text` looks like a structured summary produced by our prompts.
 * Used to seed the runtime from a prior compaction's `previousSummary`.
 */
export function isStructuredSummary(text: string): boolean {
  return STRUCTURED_MARKERS.every((marker) => text.includes(marker));
}

/**
 * Build the custom instructions for `summarizeInStages` based on whether
 * an existing structured summary is available.
 */
export function buildCompactionInstructions(existingSummary: string | undefined): {
  customInstructions: string;
  previousSummary: string | undefined;
} {
  if (existingSummary) {
    return {
      customInstructions: `${INCREMENTAL_MERGE_PROMPT}\n\n## EXISTING SUMMARY\n${existingSummary}`,
      // Don't pass previousSummary to avoid double-feeding the LLM
      previousSummary: undefined,
    };
  }
  return {
    customInstructions: STRUCTURED_SUMMARY_PROMPT,
    previousSummary: undefined,
  };
}
