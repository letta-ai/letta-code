/**
 * Release notes displayed to users once per version when they upgrade Letta Code.
 * Notes appear above the "Starting new conversation with..." line in the transcript.
 *
 * To add release notes for a new version:
 * 1. Add an entry keyed by the base version (e.g., "0.13.0", not "0.13.0-next.5")
 * 2. Use markdown formatting (rendered with MarkdownDisplay)
 * 3. Keep notes concise - 2-4 bullet points max
 */

import { settingsManager } from "./settings-manager";
import { getVersion } from "./version";

// Map of base version → markdown string
// Notes are looked up by base version (pre-release suffix stripped)
export const releaseNotes: Record<string, string> = {
  // Add release notes for new versions here.
  // Keep concise - 3-4 bullet points max.
  // Use → for bullets to match the command hints below.
  "0.13.4": `🔄 **Letta Code 0.13.4: Back to the OG experience**
→ Running **letta** now resumes your "default" conversation (instead of spawning a new one)
→ Use **letta --new** if you want to create a new conversation for concurrent sessions
→ Read more: https://docs.letta.com/letta-code/changelog#0134`,
  "0.13.0": `🎁 **Letta Code 0.13.0: Introducing Conversations!**
→ Letta Code now starts a new conversation on each startup (memory is shared across all conversations)
→ Use **/resume** to switch conversations, or run **letta --continue** to continue an existing conversation
→ Read more: https://docs.letta.com/letta-code/changelog#0130`,
};

/**
 * Get release notes for a specific base version (or null if none exist).
 */
export function getReleaseNotes(baseVersion: string): string | null {
  return releaseNotes[baseVersion] ?? null;
}

/**
 * Strip pre-release suffix from version string.
 * "0.13.0-next.5" → "0.13.0"
 */
function getBaseVersion(version: string): string {
  return version.split("-")[0] ?? version;
}

/**
 * Check if there are release notes to display for the current version.
 * Returns the notes markdown string if:
 * - Notes exist for the current base version
 * - User hasn't seen them yet (tracked in settings)
 *
 * Also updates settings to mark notes as seen.
 *
 * Debug: Set LETTA_SHOW_RELEASE_NOTES=1 to force display.
 */
export async function checkReleaseNotes(): Promise<string | null> {
  // Skip for subagents (background processes)
  if (process.env.LETTA_CODE_AGENT_ROLE === "subagent") {
    return null;
  }

  const currentVersion = getVersion();
  const baseVersion = getBaseVersion(currentVersion);

  // Debug flag to force show (still respects whether notes exist)
  if (process.env.LETTA_SHOW_RELEASE_NOTES === "1") {
    return getReleaseNotes(baseVersion);
  }

  const settings = settingsManager.getSettings();

  // Compare BASE versions so 0.13.0-next.5 → 0.13.0-next.6 doesn't re-show notes
  // This ensures users on `next` channel only see notes once per major version
  const lastSeenBase = settings.lastSeenReleaseNotesVersion
    ? getBaseVersion(settings.lastSeenReleaseNotesVersion)
    : undefined;

  if (lastSeenBase === baseVersion) {
    return null;
  }

  // Look up notes by base version (so 0.13.0-next.5 finds 0.13.0 notes)
  const notes = getReleaseNotes(baseVersion);
  if (notes) {
    // Store BASE version so future pre-releases of same version don't re-show
    await settingsManager.updateSettings({
      lastSeenReleaseNotesVersion: baseVersion,
    });
  }

  return notes;
}
