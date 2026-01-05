/**
 * Shell environment utilities
 * Provides enhanced environment variables for shell execution,
 * including bundled tools like ripgrep in PATH and Letta context for skill scripts.
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getCurrentAgentId } from "../../agent/context";
import { settingsManager } from "../../settings-manager";

/**
 * Get the directory containing the bundled ripgrep binary.
 * Returns undefined if @vscode/ripgrep is not installed.
 */
function getRipgrepBinDir(): string | undefined {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const require = createRequire(__filename);
    const rgPackage = require("@vscode/ripgrep");
    // rgPath is the full path to the binary, we want the directory
    return path.dirname(rgPackage.rgPath);
  } catch (_error) {
    return undefined;
  }
}

/**
 * Get the node_modules directory containing this package's dependencies.
 * Skill scripts use createRequire with NODE_PATH to resolve dependencies.
 */
function getPackageNodeModulesDir(): string | undefined {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const require = createRequire(__filename);
    // Find where letta-client is installed
    const clientPath = require.resolve("@letta-ai/letta-client");
    // Extract node_modules path: /a/b/node_modules/@letta-ai/letta-client/... -> /a/b/node_modules
    const match = clientPath.match(/^(.+[/\\]node_modules)[/\\]/);
    return match ? match[1] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Get enhanced environment variables for shell execution.
 * Includes bundled tools (like ripgrep) in PATH and Letta context for skill scripts.
 */
export function getShellEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };

  // Add ripgrep bin directory to PATH if available
  const rgBinDir = getRipgrepBinDir();
  if (rgBinDir) {
    const currentPath = env.PATH || "";
    env.PATH = `${rgBinDir}${path.delimiter}${currentPath}`;
  }

  // Add Letta context for skill scripts
  try {
    env.LETTA_AGENT_ID = getCurrentAgentId();
  } catch {
    // Context not set yet (e.g., during startup), skip
  }

  // Inject API key from settings if not already in env
  if (!env.LETTA_API_KEY) {
    try {
      const settings = settingsManager.getSettings();
      if (settings.env?.LETTA_API_KEY) {
        env.LETTA_API_KEY = settings.env.LETTA_API_KEY;
      }
    } catch {
      // Settings not initialized yet, skip
    }
  }

  // Add NODE_PATH for skill scripts to resolve @letta-ai/letta-client
  // ES modules don't respect NODE_PATH, but createRequire does
  const nodeModulesDir = getPackageNodeModulesDir();
  if (nodeModulesDir) {
    const currentNodePath = env.NODE_PATH || "";
    env.NODE_PATH = currentNodePath
      ? `${nodeModulesDir}${path.delimiter}${currentNodePath}`
      : nodeModulesDir;
  }

  return env;
}
