import { exec } from "node:child_process";
import { promisify } from "node:util";
import { getVersion } from "../version";

const execAsync = promisify(exec);

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

  // Check if running from source
  if (argv.includes("/src/index.ts") || argv.includes("\\src\\index.ts")) {
    return true;
  }

  // Check if running from a local build (package.json nearby)
  try {
    const { existsSync, readFileSync } = require("node:fs");
    const { dirname, join } = require("node:path");

    // Walk up from the binary location to find package.json
    let currentDir = dirname(argv);
    for (let i = 0; i < 5; i++) {
      const packageJsonPath = join(currentDir, "package.json");
      if (existsSync(packageJsonPath)) {
        const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
        if (pkg.name === "@letta-ai/letta-code") {
          return true;
        }
      }
      const parentDir = dirname(currentDir);
      if (parentDir === currentDir) break;
      currentDir = parentDir;
    }
  } catch {
    // Ignore errors
  }

  return false;
}

async function checkForUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = getVersion();

  try {
    const { stdout } = await execAsync(
      "npm view @letta-ai/letta-code version",
      { timeout: 5000 },
    );
    const latestVersion = stdout.trim();

    if (latestVersion !== currentVersion) {
      return {
        updateAvailable: true,
        latestVersion,
        currentVersion,
      };
    }
  } catch (_error) {
    // Silently fail
  }

  return {
    updateAvailable: false,
    currentVersion,
  };
}

async function performUpdate(): Promise<{ success: boolean; error?: string }> {
  try {
    await execAsync("npm install -g @letta-ai/letta-code@latest", {
      timeout: 60000,
    });
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function checkAndAutoUpdate() {
  if (!isAutoUpdateEnabled() || isRunningLocally()) {
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
