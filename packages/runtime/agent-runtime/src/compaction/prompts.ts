/**
 * Identifier preservation prompt for compaction summarization.
 * Instructs the LLM to preserve all opaque identifiers exactly.
 */
export const IDENTIFIER_PRESERVATION_INSTRUCTIONS = `
CRITICAL: You MUST preserve ALL opaque identifiers exactly as they appear. This includes:
- UUIDs (e.g., a1b2c3d4-e5f6-7890-abcd-ef1234567890)
- Hashes (e.g., sha256:abc123, commit hashes)
- Authentication tokens and API keys (preserve the format, not necessarily full value)
- URLs (full URLs including paths and query parameters)
- IP addresses and ports (e.g., 192.168.1.1:8080)
- File paths (e.g., /workspace/src/agent/tools/file-read.ts)
- Database IDs and record identifiers
- Tool call IDs (e.g., call_abc123)
- Session IDs and correlation IDs

Do NOT paraphrase, abbreviate, or generalize these identifiers. Copy them exactly.
`.trim();

/**
 * Build the full summarization prompt for a compaction chunk.
 */
export function buildSummarizationPrompt(previousSummary?: string): string {
  const parts = [
    "You are summarizing a conversation to maintain context while reducing token count.",
    "",
    IDENTIFIER_PRESERVATION_INSTRUCTIONS,
    "",
    "Focus on:",
    "- Active tasks and their current status",
    "- Decisions made and their rationale",
    "- Pending work, TODOs, and commitments",
    "- Key facts and context needed for future turns",
    "- Tool execution results and their outcomes",
    "",
    "Omit:",
    "- Pleasantries and conversational filler",
    "- Redundant information already captured",
    "- Superseded decisions (only keep the latest)",
    "",
    "Write the summary as a dense, factual record. Use bullet points for clarity.",
  ];

  if (previousSummary) {
    parts.push(
      "",
      "Previous summary (for continuity — integrate and extend, don't repeat):",
      previousSummary,
    );
  }

  return parts.join("\n");
}

/**
 * Merge prompt for combining multiple partial summaries.
 */
export const MERGE_SUMMARIES_PROMPT = `
You are merging multiple partial summaries of a conversation into a single coherent summary.

${IDENTIFIER_PRESERVATION_INSTRUCTIONS}

Focus on:
- Combining related items across summaries
- Resolving any contradictions (later summaries take precedence)
- Maintaining chronological flow of events
- Keeping the most recent context and decisions prominent
- Preserving all active tasks, TODOs, and commitments

Write a single, unified summary. Use bullet points for clarity.
`.trim();
