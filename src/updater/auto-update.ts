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
  /** True when the version check itself failed (network error, registry down, etc.) */
  checkFailed?: boolean;
}

// Supported package managers for global install/update
export type PackageManager = "npm" | "bun" | "pnpm";

const INSTALL_CMD: Record<PackageManager, string> = {
  npm: "npm install -g @letta-ai/letta-code@latest",
  bun: "bun add -g @letta-ai/letta-code@latest",
  pnpm: "pnpm add -g @letta-ai/letta-code@latest",
};

const VALID_PACKAGE_MANAGERS = new Set<string>(Object.keys(INSTALL_CMD));

/**
 * Detect which package manager was used to install this binary.
 * Checks LETTA_PACKAGE_MANAGER env var first, then inspects the resolved binary path.
 */
export function detectPackageManager(): PackageManager {
  const envOverride = process.env.LETTA_PACKAGE_MANAGER;
  if (envOverride) {
    if (VALID_PACKAGE_MANAGERS.has(envOverride)) {
      debugLog("Package manager from LETTA_PACKAGE_MANAGER:", envOverride);
      return envOverride as PackageManager;
    }
    debugLog(
      `Invalid LETTA_PACKAGE_MANAGER="${envOverride}", falling back to path detection`,
    );
  }

  const argv = process.argv[1] || "";
  let resolvedPath = argv;
  try {
    resolvedPath = realpathSync(argv);
  } catch {
    // If realpath fails, use original path
  }

  if (/[/\\]\.bun[/\\]/.test(resolvedPath)) {
    debugLog("Detected package manager from path: bun");
    return "bun";
  }
  if (/[/\\]\.?pnpm[/\\]/.test(resolvedPath)) {
    debugLog("Detected package manager from path: pnpm");
    return "pnpm";
  }

  debugLog("Detected package manager from path: npm (default)");
  return "npm";
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

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = getVersion();
  debugLog("Current version:", currentVersion);

  // Skip auto-update for prerelease versions (e.g., 0.2.0-next.3)
  // Prerelease users should manage updates manually to stay on their channel
  if (currentVersion.includes("-")) {
    debugLog("Prerelease version detected, skipping auto-update check");
    return { updateAvailable: false, currentVersion };
  }

  try {
    debugLog("Checking registry for latest version...");
    const res = await fetch(
      "https://registry.npmjs.org/@letta-ai/letta-code/latest",
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) {
      throw new Error(`Registry returned ${res.status}`);
    }
    const data = (await res.json()) as { version?: string };
    if (typeof data.version !== "string") {
      throw new Error("Unexpected registry response shape");
    }
    const latestVersion = data.version;
    debugLog("Latest version from registry:", latestVersion);

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
    return {
      updateAvailable: false,
      currentVersion,
      checkFailed: true,
    };
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
  const pm = detectPackageManager();
  const installCmd = INSTALL_CMD[pm];
  debugLog("Detected package manager:", pm);
  debugLog("Install command:", installCmd);

  // ENOTEMPTY orphan cleanup is npm-specific (npm's temp rename behavior)
  let globalPath: string | null = null;
  if (pm === "npm") {
    globalPath = await getNpmGlobalPath();
    if (globalPath) {
      debugLog("Pre-cleaning orphaned directories in:", globalPath);
      await cleanupOrphanedDirs(globalPath);
    }
  }

  try {
    debugLog(`Running ${installCmd}...`);
    await execAsync(installCmd, { timeout: 60000 });
    debugLog("Update completed successfully");
    return { success: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    // ENOTEMPTY retry is npm-specific
    if (pm === "npm" && errorMsg.includes("ENOTEMPTY") && globalPath) {
      debugLog("ENOTEMPTY detected, attempting cleanup and retry...");
      await cleanupOrphanedDirs(globalPath);

      try {
        await execAsync(installCmd, { timeout: 60000 });
        debugLog("Update succeeded after cleanup retry");
        return { success: true };
      } catch (retryError) {
        const retryMsg =
          retryError instanceof Error ? retryError.message : String(retryError);
        debugLog("Update failed after retry:", retryMsg);

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

  if (result.checkFailed) {
    return {
      success: false,
      message: "Could not check for updates (network error). Try again later.",
    };
  }

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
