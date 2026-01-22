import { exec } from "node:child_process";
import { realpathSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { getVersion } from "../version";

const execAsync = promisify(exec);

// Debug logging - set LETTA_DEBUG_AUTOUPDATE=1 to enable
const DEBUG = process.env.LETTA_DEBUG_AUTOUPDATE === "1";
function debugLog(...args: unknown[]) {
  if (DEBUG) {
    console.error("[auto-update]", ...args);
  }
}

interface UpdateCheckResult {
  updateAvailable: boolean;
  latestVersion?: string;
  currentVersion: string;
}

function isAutoUpdateEnabled(): boolean {
  return process.env.DISABLE_AUTOUPDATER !== "1";
}

function isRunningLocally(): boolean {
  const argv = process.argv[1] || "";

  // Resolve symlinks to get the real path
  // npm creates symlinks in /bin/ that point to /lib/node_modules/
  // Without resolving, argv would be like ~/.nvm/.../bin/letta (no node_modules)
  let resolvedPath = argv;
  try {
    resolvedPath = realpathSync(argv);
  } catch {
    // If realpath fails (file doesn't exist), use original path
  }

  debugLog("argv[1]:", argv);
  debugLog("resolved path:", resolvedPath);

  // If running from node_modules, it's npm installed (should auto-update)
  // Otherwise it's local dev (source or built locally)
  return !resolvedPath.includes("node_modules");
}

async function checkForUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = getVersion();
  debugLog("Current version:", currentVersion);

  // Skip auto-update for prerelease versions (e.g., 0.2.0-next.3)
  // Prerelease users should manage updates manually to stay on their channel
  if (currentVersion.includes("-")) {
    debugLog("Prerelease version detected, skipping auto-update check");
    return { updateAvailable: false, currentVersion };
  }

  try {
    debugLog("Checking npm for latest version...");
    const { stdout } = await execAsync(
      "npm view @letta-ai/letta-code version",
      { timeout: 5000 },
    );
    const latestVersion = stdout.trim();
    debugLog("Latest version from npm:", latestVersion);

    if (latestVersion !== currentVersion) {
      debugLog("Update available!");
      return {
        updateAvailable: true,
        latestVersion,
        currentVersion,
      };
    }
    debugLog("Already on latest version");
  } catch (error) {
    debugLog("Failed to check for updates:", error);
  }

  return {
    updateAvailable: false,
    currentVersion,
  };
}

/**
 * Get the npm global prefix path (e.g., /Users/name/.npm-global or ~/.nvm/versions/node/v20/lib)
 */
async function getNpmGlobalPath(): Promise<string | null> {
  try {
    const { stdout } = await execAsync("npm prefix -g", { timeout: 5000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Clean up orphaned temp directories left by interrupted npm installs.
 * These look like: .letta-code-lnWEqMep (npm's temp rename targets)
 */
async function cleanupOrphanedDirs(globalPath: string): Promise<void> {
  const lettaAiDir = join(globalPath, "lib/node_modules/@letta-ai");
  try {
    const entries = await readdir(lettaAiDir);
    for (const entry of entries) {
      // Match orphaned temp dirs like .letta-code-lnWEqMep
      if (entry.startsWith(".letta-code-")) {
        const orphanPath = join(lettaAiDir, entry);
        debugLog("Cleaning orphaned temp directory:", orphanPath);
        await rm(orphanPath, { recursive: true, force: true });
      }
    }
  } catch {
    // Directory might not exist or not readable, ignore
  }
}

async function performUpdate(): Promise<{
  success: boolean;
  error?: string;
  enotemptyFailed?: boolean;
}> {
  // Pre-emptively clean up orphaned directories to prevent ENOTEMPTY errors
  const globalPath = await getNpmGlobalPath();
  if (globalPath) {
    debugLog("Pre-cleaning orphaned directories in:", globalPath);
    await cleanupOrphanedDirs(globalPath);
  }

  try {
    debugLog("Running npm install -g @letta-ai/letta-code@latest...");
    await execAsync("npm install -g @letta-ai/letta-code@latest", {
      timeout: 60000,
    });
    debugLog("Update completed successfully");
    return { success: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    // If ENOTEMPTY still occurred (race condition or new orphans), try cleanup + retry once
    if (errorMsg.includes("ENOTEMPTY") && globalPath) {
      debugLog("ENOTEMPTY detected, attempting cleanup and retry...");
      await cleanupOrphanedDirs(globalPath);

      try {
        await execAsync("npm install -g @letta-ai/letta-code@latest", {
          timeout: 60000,
        });
        debugLog("Update succeeded after cleanup retry");
        return { success: true };
      } catch (retryError) {
        const retryMsg =
          retryError instanceof Error ? retryError.message : String(retryError);
        debugLog("Update failed after retry:", retryMsg);

        // If it's still ENOTEMPTY after retry, flag it for user notification
        if (retryMsg.includes("ENOTEMPTY")) {
          return {
            success: false,
            error: retryMsg,
            enotemptyFailed: true,
          };
        }
        return { success: false, error: retryMsg };
      }
    }

    debugLog("Update failed:", error);
    return { success: false, error: errorMsg };
  }
}

export interface AutoUpdateResult {
  /** Whether an ENOTEMPTY error persisted after cleanup and retry */
  enotemptyFailed?: boolean;
}

export async function checkAndAutoUpdate(): Promise<
  AutoUpdateResult | undefined
> {
  debugLog("Auto-update check starting...");
  debugLog("isAutoUpdateEnabled:", isAutoUpdateEnabled());
  const runningLocally = isRunningLocally();
  debugLog("isRunningLocally:", runningLocally);

  if (!isAutoUpdateEnabled()) {
    debugLog("Auto-update disabled via DISABLE_AUTOUPDATER=1");
    return;
  }

  if (runningLocally) {
    debugLog("Running locally, skipping auto-update");
    return;
  }

  const result = await checkForUpdate();

  if (result.updateAvailable) {
    const updateResult = await performUpdate();
    if (updateResult.enotemptyFailed) {
      return { enotemptyFailed: true };
    }
  }
}

export async function manualUpdate(): Promise<{
  success: boolean;
  message: string;
}> {
  if (isRunningLocally()) {
    return {
      success: false,
      message: "Manual updates are disabled in development mode",
    };
  }

  const result = await checkForUpdate();

  if (!result.updateAvailable) {
    return {
      success: true,
      message: `Already on latest version (${result.currentVersion})`,
    };
  }

  console.log(
    `Updating from ${result.currentVersion} to ${result.latestVersion}...`,
  );

  const updateResult = await performUpdate();

  if (updateResult.success) {
    return {
      success: true,
      message: `Updated to ${result.latestVersion}. Restart Letta Code to use the new version.`,
    };
  }

  return {
    success: false,
    message: `Update failed: ${updateResult.error}`,
  };
}
