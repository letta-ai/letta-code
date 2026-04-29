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
import { getConversationId, getCurrentAgentId } from "../../agent/context";
import { getMemoryFilesystemRoot } from "../../agent/memoryFilesystem";
import { getServerUrl } from "../../backend/api/client";
import { getCurrentWorkingDirectory } from "../../runtime-context";
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

export function resolveEntryScriptPath(
  scriptPath: string,
  cwd: string = process.cwd(),
): string {
  if (!scriptPath) return scriptPath;
  if (path.posix.isAbsolute(scriptPath) || path.win32.isAbsolute(scriptPath)) {
    return scriptPath;
  }
  return path.resolve(cwd, scriptPath);
}

function isDevLettaEntryScript(
  scriptPath: string,
  cwd: string = process.cwd(),
): boolean {
  const normalized = resolveEntryScriptPath(scriptPath, cwd).replaceAll(
    "\\",
    "/",
  );
  return normalized.endsWith("/src/index.ts");
}

export function resolveLettaInvocation(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
  execPath: string = process.execPath,
  cwd: string = process.cwd(),
): LettaInvocation | null {
  const explicitBin = normalizeInvocationCommand(env.LETTA_CODE_BIN);
  if (explicitBin) {
    return {
      command: explicitBin,
      args: parseInvocationArgs(env[LETTA_BIN_ARGS_ENV]),
    };
  }

  const scriptPath = argv[1] || "";
  if (scriptPath && isDevLettaEntryScript(scriptPath, cwd)) {
    const resolvedScriptPath = resolveEntryScriptPath(scriptPath, cwd);
    const runtimeName = path.basename(execPath).toLowerCase();
    if (runtimeName.includes("bun")) {
      return {
        command: execPath,
        args: [
          "--loader:.md=text",
          "--loader:.mdx=text",
          "--loader:.txt=text",
          "run",
          resolvedScriptPath,
        ],
      };
    }

    return { command: execPath, args: [resolvedScriptPath] };
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

const LETTA_CLOUD_MEMFS_GIT_BASE_URL = "https://api.letta.com";
const LETTA_MEMFS_GIT_PROXY_BASE_URL_ENV = "LETTA_MEMFS_GIT_PROXY_BASE_URL";

function isLocalhostUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function trimBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function getShellMemfsBaseUrl(env: NodeJS.ProcessEnv): string {
  // Use the shell environment as the source of truth for command execution.
  // This keeps Desktop's transient LETTA_BASE_URL proxy from affecting the
  // canonical MemFS git remote, while still allowing an explicit MemFS base
  // override to opt out of the Cloud rewrite.
  return env.LETTA_MEMFS_BASE_URL || LETTA_CLOUD_MEMFS_GIT_BASE_URL;
}

function getShellMemfsGitProxyRewriteConfig(
  env: NodeJS.ProcessEnv,
): { configKey: string; configValue: string } | null {
  const rawProxyBaseUrl = env[LETTA_MEMFS_GIT_PROXY_BASE_URL_ENV]?.trim();
  if (!rawProxyBaseUrl || !isLocalhostUrl(rawProxyBaseUrl)) {
    return null;
  }

  const memfsBaseUrl = trimBaseUrl(getShellMemfsBaseUrl(env));
  if (!memfsBaseUrl.includes("api.letta.com")) {
    return null;
  }

  const proxyBaseUrl = trimBaseUrl(rawProxyBaseUrl);
  const proxyPrefix = `${proxyBaseUrl}/v1/git/`;
  const memfsPrefix = `${memfsBaseUrl}/v1/git/`;

  return {
    configKey: `url.${proxyPrefix}.insteadOf`,
    configValue: memfsPrefix,
  };
}

function appendGitConfigEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  value: string,
): void {
  const rawCount = env.GIT_CONFIG_COUNT;
  const count = rawCount && /^\d+$/.test(rawCount) ? Number(rawCount) : 0;
  env[`GIT_CONFIG_KEY_${count}`] = key;
  env[`GIT_CONFIG_VALUE_${count}`] = value;
  env.GIT_CONFIG_COUNT = String(count + 1);
}

function applyMemfsGitProxyEnv(env: NodeJS.ProcessEnv): void {
  const rewrite = getShellMemfsGitProxyRewriteConfig(env);
  if (!rewrite) {
    return;
  }

  appendGitConfigEnv(env, rewrite.configKey, rewrite.configValue);
  env.GIT_TERMINAL_PROMPT = "0";
  env.GCM_INTERACTIVE = "never";
  env.GIT_ASKPASS = "";
  env.SSH_ASKPASS = "";
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

  env.USER_CWD = getCurrentWorkingDirectory();

  // Add Letta context for skill scripts.
  // Prefer explicit agent context, but fall back to inherited env values.
  let agentId: string | undefined;
  try {
    const resolvedAgentId = getCurrentAgentId();
    if (typeof resolvedAgentId === "string" && resolvedAgentId.trim()) {
      agentId = resolvedAgentId.trim();
    }
  } catch {
    // Context not set yet (e.g., during startup), try env fallback below.
  }

  if (!agentId) {
    const fallbackAgentId = env.AGENT_ID || env.LETTA_AGENT_ID;
    if (typeof fallbackAgentId === "string" && fallbackAgentId.trim()) {
      agentId = fallbackAgentId.trim();
    }
  }

  if (agentId) {
    env.LETTA_AGENT_ID = agentId;
    env.AGENT_ID = agentId;

    try {
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
      // Settings may not be initialized in tests/startup; preserve inherited values.
    }
  }
  // Inject conversation ID if available
  let convId: string | undefined;
  try {
    const resolved = getConversationId();
    if (resolved) convId = resolved;
  } catch {
    // Not set yet
  }
  if (!convId) {
    const fallback = env.LETTA_CONVERSATION_ID;
    if (typeof fallback === "string" && fallback.trim()) {
      convId = fallback.trim();
    }
  }
  if (convId) {
    env.LETTA_CONVERSATION_ID = convId;
    env.CONVERSATION_ID = convId;
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

  // Desktop's local listener only has a localhost session token; the proxy owns
  // the real Cloud token. Apply a process-local git URL rewrite so agent-run
  // `git push`/`pull` inside $MEMORY_DIR uses the proxy without persisting the
  // ephemeral localhost URL into the memory repo's git config.
  applyMemfsGitProxyEnv(env);

  return env;
}
