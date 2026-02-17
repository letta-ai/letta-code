/**
 * Shell environment utilities
 * Provides enhanced environment variables for shell execution,
 * including bundled tools like ripgrep in PATH and Letta context for skill scripts.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getServerUrl } from "../../agent/client";
import { getCurrentAgentId } from "../../agent/context";
import { getMemoryFilesystemRoot } from "../../agent/memoryFilesystem";
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

interface LettaInvocation {
  command: string;
  args: string[];
}

const LETTA_BIN_ARGS_ENV = "LETTA_CODE_BIN_ARGS_JSON";

function normalizeInvocationCommand(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const wrappedInDoubleQuotes =
    trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"');
  const wrappedInSingleQuotes =
    trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'");

  const normalized =
    wrappedInDoubleQuotes || wrappedInSingleQuotes
      ? trimmed.slice(1, -1).trim()
      : trimmed;

  return normalized || null;
}

function parseInvocationArgs(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.every((item) => typeof item === "string")
    ) {
      return parsed;
    }
  } catch {
    // Ignore malformed JSON and fall back to empty args.
  }
  return [];
}

function isDevLettaEntryScript(scriptPath: string): boolean {
  const normalized = scriptPath.replaceAll("\\", "/");
  return normalized.endsWith("/src/index.ts");
}

export function resolveLettaInvocation(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
  execPath: string = process.execPath,
): LettaInvocation | null {
  const explicitBin = normalizeInvocationCommand(env.LETTA_CODE_BIN);
  if (explicitBin) {
    return {
      command: explicitBin,
      args: parseInvocationArgs(env[LETTA_BIN_ARGS_ENV]),
    };
  }

  const scriptPath = argv[1] || "";
  if (scriptPath && isDevLettaEntryScript(scriptPath)) {
    return { command: execPath, args: [scriptPath] };
  }

  return null;
}

function shellEscape(arg: string): string {
  return `'${arg.replaceAll("'", `'"'"'`)}'`;
}

export function ensureLettaShimDir(invocation: LettaInvocation): string | null {
  if (!invocation.command) return null;

  const shimDir = path.join(tmpdir(), "letta-code-shell-shim");
  mkdirSync(shimDir, { recursive: true });

  if (process.platform === "win32") {
    const cmdPath = path.join(shimDir, "letta.cmd");
    const quotedCommand = `"${invocation.command.replaceAll('"', '""')}"`;
    const quotedArgs = invocation.args
      .map((arg) => `"${arg.replaceAll('"', '""')}"`)
      .join(" ");
    writeFileSync(
      cmdPath,
      `@echo off\r\n${quotedCommand} ${quotedArgs} %*\r\n`,
    );
    return shimDir;
  }

  const shimPath = path.join(shimDir, "letta");
  const commandWithArgs = [invocation.command, ...invocation.args]
    .map(shellEscape)
    .join(" ");
  writeFileSync(shimPath, `#!/bin/sh\nexec ${commandWithArgs} "$@"\n`, {
    mode: 0o755,
  });
  return shimDir;
}

/**
 * Get enhanced environment variables for shell execution.
 * Includes bundled tools (like ripgrep) in PATH and Letta context for skill scripts.
 */
export function getShellEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const pathKey =
    Object.keys(env).find((k) => k.toUpperCase() === "PATH") || "PATH";
  const pathPrefixes: string[] = [];

  const lettaInvocation = resolveLettaInvocation(env);
  if (lettaInvocation) {
    env.LETTA_CODE_BIN = lettaInvocation.command;
    env[LETTA_BIN_ARGS_ENV] = JSON.stringify(lettaInvocation.args);
    const shimDir = ensureLettaShimDir(lettaInvocation);
    if (shimDir) {
      pathPrefixes.push(shimDir);
    }
  }

  // Add ripgrep bin directory to PATH if available
  const rgBinDir = getRipgrepBinDir();
  if (rgBinDir) {
    pathPrefixes.push(rgBinDir);
  }

  if (pathPrefixes.length > 0) {
    const existingPath = env[pathKey] || "";
    env[pathKey] = existingPath
      ? `${pathPrefixes.join(path.delimiter)}${path.delimiter}${existingPath}`
      : pathPrefixes.join(path.delimiter);
  }

  // Add Letta context for skill scripts
  try {
    const agentId = getCurrentAgentId();
    env.LETTA_AGENT_ID = agentId;
    env.AGENT_ID = agentId;

    if (settingsManager.isMemfsEnabled(agentId)) {
      const memoryDir = getMemoryFilesystemRoot(agentId);
      env.LETTA_MEMORY_DIR = memoryDir;
      env.MEMORY_DIR = memoryDir;
    } else {
      // Clear inherited/stale memory-dir vars for non-memfs agents.
      delete env.LETTA_MEMORY_DIR;
      delete env.MEMORY_DIR;
    }
  } catch {
    // Context not set yet (e.g., during startup), skip
  }
  // Inject API key and base URL from settings if not already in env
  if (!env.LETTA_API_KEY || !env.LETTA_BASE_URL) {
    try {
      const settings = settingsManager.getSettings();
      if (!env.LETTA_API_KEY && settings.env?.LETTA_API_KEY) {
        env.LETTA_API_KEY = settings.env.LETTA_API_KEY;
      }
      if (!env.LETTA_BASE_URL) {
        env.LETTA_BASE_URL = getServerUrl();
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

  // Disable interactive pagers (fixes git log, man, etc. hanging)
  env.PAGER = "cat";
  env.GIT_PAGER = "cat";
  env.MANPAGER = "cat";

  // Ensure TERM is set for proper color support
  if (!env.TERM) {
    env.TERM = "xterm-256color";
  }

  return env;
}
