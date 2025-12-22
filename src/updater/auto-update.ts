import { exec } from "node:child_process";
import { realpathSync } from "node:fs";
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

async function performUpdate(): Promise<{ success: boolean; error?: string }> {
  try {
    debugLog("Running npm install -g @letta-ai/letta-code@latest...");
    await execAsync("npm install -g @letta-ai/letta-code@latest", {
      timeout: 60000,
    });
    debugLog("Update completed successfully");
    return { success: true };
  } catch (error) {
    debugLog("Update failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function checkAndAutoUpdate() {
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
    await performUpdate();
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
