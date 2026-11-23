import { settingsManager } from "./settings-manager";
import { compareSemver } from "./utils/version";
import { getVersion } from "./version";

export const releaseNotes: Record<string, string> = {
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

export function getReleaseNotes(baseVersion: string): string | null {
  return releaseNotes[baseVersion] ?? null;
}

export function getBaseVersion(version: string): string {
  return version.split("-")[0] ?? version;
}

function getOrderedReleaseNoteVersions(): string[] {
  return Object.keys(releaseNotes).sort((a, b) => {
    const comparison = compareSemver(a, b);
    return comparison ?? a.localeCompare(b);
  });
}

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

export async function checkReleaseNotes(): Promise<string | null> {
  if (process.env.LETTA_CODE_AGENT_ROLE === "subagent") {
    return null;
  }

  const currentVersion = getVersion();
  const baseVersion = getBaseVersion(currentVersion);

  if (process.env.LETTA_SHOW_RELEASE_NOTES === "1") {
    return getReleaseNotes(baseVersion);
  }

  const settings = settingsManager.getSettings();
  const notes = getPendingReleaseNotes(
    currentVersion,
    settings.lastSeenReleaseNotesVersion,
  );

  if (notes) {
    await settingsManager.updateSettings({
      lastSeenReleaseNotesVersion: baseVersion,
    });
  }

  return notes;
}
