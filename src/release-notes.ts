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
import { compareSemver } from "./utils/version";
import { getVersion } from "./version";

// Map of base version → markdown string
// Notes are looked up by base version (pre-release suffix stripped)
export const releaseNotes: Record<string, string> = {
  // Add release notes for new versions here.
  // Keep concise - 3-4 bullet points max.
  // Use → for bullets to match the command hints below.
  "0.27.0": `🧠 **Updated default system prompt available**
→ Improves Letta Code's understanding of time and memory retrieval
→ Run **/system** to upgrade your agent to the latest prompt`,
  "0.25.7": `🔐 **Permissions update in Letta Code 0.25.7**
→ The default permission mode is now **unrestricted**, so Letta Code starts without approval prompts unless you change it
→ Run **/permissions** and choose **standard** if you want the old request-approval behavior back
→ You can also press **shift+tab** to cycle modes until you reach **standard**
→ Read more: https://github.com/letta-ai/letta-code/pull/2197`,
  "0.13.4": `🔄 **Letta Code 0.13.4: Back to the OG experience**
→ Running **letta** now resumes your "default" conversation (instead of spawning a new one)
→ Use **letta --new** if you want to create a new conversation for concurrent sessions
→ Read more: https://docs.letta.com/letta-code/changelog#0134`,
  "0.13.0": `🎁 **Letta Code 0.13.0: Introducing Conversations!**
→ Letta Code now starts a new conversation on each startup (memory is shared across all conversations)
→ Use **/resume** to switch conversations, or run **letta --conv <id>** to continue a specific conversation
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
export function getBaseVersion(version: string): string {
  return version.split("-")[0] ?? version;
}

function getOrderedReleaseNoteVersions(): string[] {
  return Object.keys(releaseNotes).sort((a, b) => {
    const comparison = compareSemver(a, b);
    return comparison ?? a.localeCompare(b);
  });
}

/**
 * Return release note versions the user has not seen yet between their last
 * seen checkpoint and the current version.
 *
 * If there is no checkpoint yet, only the current version's note is shown.
 */
export function getPendingReleaseNoteVersions(
  currentVersion: string,
  lastSeenVersion?: string,
): string[] {
  const currentBase = getBaseVersion(currentVersion);

  if (!lastSeenVersion) {
    return getReleaseNotes(currentBase) ? [currentBase] : [];
  }

  const lastSeenBase = getBaseVersion(lastSeenVersion);
  if (lastSeenBase === currentBase) {
    return [];
  }

  return getOrderedReleaseNoteVersions().filter((version) => {
    const isAfterLastSeen = compareSemver(version, lastSeenBase);
    const isAtOrBeforeCurrent = compareSemver(version, currentBase);
    return (
      isAfterLastSeen === 1 &&
      (isAtOrBeforeCurrent === -1 || isAtOrBeforeCurrent === 0)
    );
  });
}

export function getPendingReleaseNotes(
  currentVersion: string,
  lastSeenVersion?: string,
): string | null {
  const versions = getPendingReleaseNoteVersions(
    currentVersion,
    lastSeenVersion,
  );
  if (versions.length === 0) {
    return null;
  }

  return versions
    .map((version) => releaseNotes[version])
    .filter((note): note is string => typeof note === "string")
    .join("\n\n");
}

/**
 * Check if there are release notes to display for the current version.
 * Returns the notes markdown string if:
 * - Notes exist for the current base version or any skipped versions since the
 *   user's last seen checkpoint
 * - User hasn't already crossed this checkpoint (tracked in settings)
 *
 * Also updates settings to mark notes as seen up to the current base version.
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
  const notes = getPendingReleaseNotes(
    currentVersion,
    settings.lastSeenReleaseNotesVersion,
  );

  if (notes) {
    // Store current BASE version so skipped notes are not re-shown on the next run.
    await settingsManager.updateSettings({
      lastSeenReleaseNotesVersion: baseVersion,
    });
  }

  return notes;
}
