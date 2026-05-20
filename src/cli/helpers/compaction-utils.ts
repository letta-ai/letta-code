/**
 * Check if a user message is a compaction summary (system_alert with summary content).
 * Returns the summary text if found, null otherwise.
 *
 * Kept in a standalone file so both accumulator.ts and backfill.ts can import
 * it without creating a circular dependency between them.
 */
export function extractCompactionSummary(text: string): string | null {
  try {
    const parsed = JSON.parse(text);
    if (parsed.type === "system_alert" && typeof parsed.message === "string") {
      // Extract the summary part after the header (handles both old and new server formats)
      const summaryMatch = parsed.message.match(
        /The following is an? (?:in-context recursive )?summary(?: of the (?:previous|prior) messages)?:\s*([\s\S]*)/,
      );
      if (summaryMatch?.[1]) {
        return summaryMatch[1].trim();
      }
      return parsed.message;
    }
  } catch {
    // Not JSON, not a compaction summary
  }
  return null;
}
