/**
 * Format a tip for users running agents with outdated system prompts.
 */
export function formatDriftTip(): string {
  return "Tip: This agent is using an older system prompt. Run /system default to upgrade to the latest version with automatic prompt management.";
}
