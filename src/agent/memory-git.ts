/**
 * Git operations for git-backed agent memory.
 *
 * When memFS is enabled, the agent's memory is stored in a git repo
 * on the server at $LETTA_MEMFS_BASE_URL/v1/git/$AGENT_ID/state.git
 * (falling back to api.letta.com when unset). Desktop may route git transport
 * through a localhost proxy transiently, but that URL must not be persisted in
 * the repo's git config.
 * This module provides the CLI harness helpers: clone on first run,
 * pull on startup, commit memory writes, post-turn push for clean pending
 * commits, and status checks for system reminders.
 */

import { execFile as execFileCb } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { getClient } from "@/backend/api/client";
import {
  getMemfsGitProxyRewriteConfig,
  getMemfsServerUrl,
} from "@/backend/api/memfs-git-proxy";
import { apiRequest } from "@/backend/api/request";
import { debugLog, debugWarn } from "@/utils/debug";
import { getUtf16Bom } from "@/utils/text-files";
import { GIT_MEMORY_ENABLED_TAG } from "./agent-tags";
import { getScopedMemoryFilesystemRoot } from "./memory-filesystem";

const execFile = promisify(execFileCb);

const RETRYABLE_GIT_HTTP_ERROR_RE =
  /(?:\bHTTP\s+(?:520|521|522|523|524)\b|The requested URL returned error:\s*(?:520|521|522|523|524))/i;
const RETRYABLE_GIT_NETWORK_ERROR_RE =
  /(remote end hung up unexpectedly|connection reset by peer|operation timed out|timed out|SIGTERM|ETIMEDOUT)/i;

const MISSING_CWD_GIT_ERROR_RE =
  /(Unable to read current working directory: No such file or directory|\buv_cwd\b|\bcwd\b.*\bENOENT\b)/i;

const NON_FAST_FORWARD_PUSH_ERROR_RE =
  /(non-fast-forward|fetch first|failed to push some refs|updates were rejected|remote contains work that you do not have locally|tip of your current branch is behind)/i;

const UNRELATED_HISTORY_PULL_ERROR_RE =
  /(no common commits|refusing to merge unrelated histories)/i;

const NO_UPSTREAM_PULL_ERROR_RE =
  /(there is no tracking information for the current branch|no upstream configured|no tracking branch)/i;

const AGENT_DISPLAY_NAME_TIMEOUT_MS = 3_000;

export interface MemoryCommitAuthor {
  agentId: string;
  authorName: string;
  authorEmail: string;
}

export interface CommitMemoryWriteParams {
  memoryDir: string;
  pathspecs: string[];
  reason: string;
  author: MemoryCommitAuthor;
  syncMode?: MemoryWriteSyncMode;
}

export type MemoryWriteSyncMode = "remote" | "local";

export interface CommitMemoryWriteResult {
  committed: boolean;
  sha?: string;
}

/** Get the agent root directory (~/.letta/agents/{id}/) */
export function getAgentRootDir(agentId: string): string {
  return join(homedir(), ".letta", "agents", agentId);
}

/** Get the git repo directory for memory (now ~/.letta/agents/{id}/memory/) */
export function getMemoryRepoDir(agentId: string): string {
  return join(getAgentRootDir(agentId), "memory");
}

function getMemoryRepositoryRepoDir(agentId: string): string {
  return getScopedMemoryFilesystemRoot(agentId);
}

/**
 * Normalize a configured server URL for use in git credential config keys.
 *
 * Git credential config lookup is sensitive to URL key shape. We normalize to
 * origin form (scheme + host + optional port) and remove trailing slashes so
 * pull/push flows remain resilient when LETTA_MEMFS_BASE_URL /
 * LETTA_BASE_URL has path/trailing-slash variations.
 */
export function normalizeCredentialBaseUrl(serverUrl: string): string {
  const trimmed = serverUrl.trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(trimmed);
    return parsed.origin;
  } catch {
    // Fall back to a conservative slash-trimmed value if URL parsing fails.
    return trimmed;
  }
}

/**
 * Format an executable helper path for git config values.
 *
 * Git splits helper commands on whitespace, so we must escape any
 * spaces/tabs in absolute paths (common on Windows profile paths).
 */
export function formatGitCredentialHelperPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\s/g, "\\$&");
}

function normalizeRemoteUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactCredentialedHttpsUrl(value: string): string {
  return value.replace(/https?:\/\/([^:\s/@]+):([^@\s]+)@/gi, (match) =>
    match.replace(/:([^:@]+)@$/, ":***@"),
  );
}

/**
 * Redact git auth material from command/error text before it reaches logs.
 *
 * Node's child_process errors include the full command line in `message`/`cmd`.
 * MemFS git operations pass API keys through `-c http.extraHeader=...`, so a
 * failed clone/fetch/pull/push can otherwise print a reusable credential.
 */
export function redactGitAuthInText(value: string): string {
  return value
    .replace(
      /(http\.extraHeader=Authorization:\s*(?:Basic|Bearer)\s+)[^\s'"`]+/gi,
      "$1<redacted>",
    )
    .replace(
      /(Authorization:\s*(?:Basic|Bearer)\s+)[^\s'"`]+/gi,
      "$1<redacted>",
    )
    .replace(/(password=)[^\s'"`;]+/gi, "$1<redacted>")
    .replace(/sk-let-[A-Za-z0-9_-]+/g, "sk-let-<redacted>");
}

function redactGitAuthError(error: unknown): Error {
  if (error instanceof Error) {
    error.message = redactGitAuthInText(error.message);

    const mutableError = error as Error & Record<string, unknown>;
    for (const key of [
      "cmd",
      "command",
      "stack",
      "stdout",
      "stderr",
    ] as const) {
      const value = mutableError[key];
      if (typeof value === "string") {
        mutableError[key] = redactGitAuthInText(value);
      }
    }

    return error;
  }

  return new Error(redactGitAuthInText(String(error)));
}

/**
 * Returns true when a remote URL points to this agent's memfs git endpoint.
 */
export function isMemfsRemoteUrlForAgent(
  remoteUrl: string,
  agentId: string,
): boolean {
  const normalized = normalizeRemoteUrl(remoteUrl);
  const escapedAgentId = escapeRegex(agentId);
  return new RegExp(
    `^https?://[^\\s]+/v1/git/${escapedAgentId}/state\\.git$`,
    "i",
  ).test(normalized);
}

/**
 * Returns true when an origin URL is clearly intended to be a Letta MemFS
 * remote for this agent, including older/broken forms we can safely repair.
 */
export function isRepairableMemfsRemoteUrl(
  remoteUrl: string,
  agentId: string,
): boolean {
  const normalized = normalizeRemoteUrl(remoteUrl);
  const escapedAgentId = escapeRegex(agentId);

  if (isMemfsRemoteUrlForAgent(normalized, agentId)) {
    return true;
  }

  // Legacy remote shape: /v1/git/{agent_id}. Git appends /info/refs to this,
  // which server-side compatibility now handles, but the persisted origin
  // should still be repaired to the canonical /state.git URL.
  if (
    new RegExp(`^https?://[^\\s]+/v1/git/${escapedAgentId}$`, "i").test(
      normalized,
    )
  ) {
    return true;
  }

  // Broken Desktop/local proxy shape observed in the wild: origin is just the
  // git proxy prefix (/v1/git) with no agent or repo suffix. The CLI knows the
  // active agent, so repair this before trying to sync.
  return /^https?:\/\/[^\s]+\/v1\/git$/i.test(normalized);
}

/** Git remote URL for the agent's state repo */
export function getGitRemoteUrl(agentId: string, baseUrl?: string): string {
  const resolvedBaseUrl = (baseUrl ?? getMemfsServerUrl())
    .trim()
    .replace(/\/+$/, "");
  return `${resolvedBaseUrl}/v1/git/${agentId}/state.git`;
}

export function getRepositoryRemoteUrl(
  agentId: string,
  repositoryName: string,
  baseUrl?: string,
): string {
  const resolvedBaseUrl = (baseUrl ?? getMemfsServerUrl())
    .trim()
    .replace(/\/+$/, "");
  return `${resolvedBaseUrl}/v1/git/${agentId}/repositories/${encodeURIComponent(repositoryName)}.git`;
}

export function getRepositoryMountDir(
  agentId: string,
  repositoryName: string,
): string {
  return join(dirname(getMemoryRepoDir(agentId)), repositoryName);
}

function validateAgentRepositoryName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("repository name is required");
  }
  if (trimmed !== name) {
    throw new Error(
      "repository name cannot have leading or trailing whitespace",
    );
  }
  if (trimmed === "." || trimmed === "..") {
    throw new Error("invalid repository name");
  }
  if (trimmed.toLowerCase() === "memory") {
    throw new Error("'memory' is reserved");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error(
      "repository name can only contain letters, numbers, dots, underscores, and hyphens",
    );
  }
  if (trimmed.length > 64) {
    throw new Error("repository name is too long");
  }
  return trimmed;
}

async function maybeUpdateRepositoryRemoteOrigin(args: {
  directory: string;
  remoteUrl: string;
}): Promise<void> {
  const expectedOrigin = normalizeRemoteUrl(args.remoteUrl);
  let currentOrigin = "";
  try {
    const { stdout } = await runGit(args.directory, [
      "remote",
      "get-url",
      "origin",
    ]);
    currentOrigin = stdout.trim();
  } catch {
    await runGit(args.directory, ["remote", "add", "origin", expectedOrigin]);
    return;
  }

  if (normalizeRemoteUrl(currentOrigin) !== expectedOrigin) {
    await runGit(args.directory, [
      "remote",
      "set-url",
      "origin",
      expectedOrigin,
    ]);
  }
}

async function prepareAttachedRepositoryForGitOps(args: {
  agentId: string;
  repositoryName: string;
  directory: string;
  remoteUrl: string;
  token: string;
}): Promise<void> {
  await maybeUpdateRepositoryRemoteOrigin(args);
  await configureLocalCredentialHelper(args.directory, args.token);
  await ensureLocalMemfsGitConfig(args.directory, args.agentId);
}

async function cloneRepositoryMount(args: {
  agentId: string;
  repositoryName: string;
  directory: string;
  remoteUrl: string;
  token: string;
}): Promise<void> {
  if (!existsSync(args.directory)) {
    mkdirSync(args.directory, { recursive: true });
    try {
      await runGitWithRetry(
        args.directory,
        ["clone", args.remoteUrl, "."],
        args.token,
        {
          operation: `clone repository ${args.repositoryName}`,
          timeoutMs: GIT_CLONE_TIMEOUT_MS,
        },
      );
    } catch (err) {
      rmSync(args.directory, { recursive: true, force: true });
      throw err;
    }
  } else if (!existsSync(join(args.directory, ".git"))) {
    throw new Error(
      `repository mount path already exists and is not a git repository: ${args.directory}`,
    );
  } else {
    await prepareAttachedRepositoryForGitOps(args);
    await runGitWithRetry(args.directory, ["pull", "--ff-only"], args.token, {
      operation: `pull repository ${args.repositoryName}`,
    });
  }

  await prepareAttachedRepositoryForGitOps(args);
}

/**
 * Keep the local repo's `origin` URL aligned with the current server base URL.
 *
 * Best-effort: if origin is missing or not a memfs endpoint for this agent,
 * this function is a no-op.
 */
export async function maybeUpdateMemoryRemoteOrigin(
  repoDir: string,
  agentId: string,
): Promise<void> {
  let currentOrigin = "";
  try {
    const { stdout } = await runGit(repoDir, ["remote", "get-url", "origin"]);
    currentOrigin = stdout.trim();
  } catch {
    // No origin remote configured — create one so pushes have a destination.
    const expectedOrigin = normalizeRemoteUrl(getGitRemoteUrl(agentId));
    await runGit(repoDir, ["remote", "add", "origin", expectedOrigin]);
    console.warn(
      `[memfs-git] Created missing origin remote for agent ${agentId}: ${expectedOrigin}`,
    );
    debugLog(
      "memfs-git",
      `Created missing origin remote for ${agentId}: ${expectedOrigin}`,
    );
    return;
  }

  if (!currentOrigin) {
    // origin key exists but value is empty — set it.
    const expectedOrigin = normalizeRemoteUrl(getGitRemoteUrl(agentId));
    await runGit(repoDir, ["remote", "set-url", "origin", expectedOrigin]);
    console.warn(
      `[memfs-git] Set empty origin remote for agent ${agentId}: ${expectedOrigin}`,
    );
    debugLog(
      "memfs-git",
      `Set empty origin remote for ${agentId}: ${expectedOrigin}`,
    );
    return;
  }

  if (!isRepairableMemfsRemoteUrl(currentOrigin, agentId)) {
    return;
  }

  const expectedOrigin = normalizeRemoteUrl(getGitRemoteUrl(agentId));
  const normalizedCurrent = normalizeRemoteUrl(currentOrigin);

  if (normalizedCurrent !== expectedOrigin) {
    await runGit(repoDir, ["remote", "set-url", "origin", expectedOrigin]);

    debugLog(
      "memfs-git",
      `Updated origin remote for ${agentId}: ${normalizedCurrent} -> ${expectedOrigin}`,
    );
  }

  await clearOriginPushUrl(repoDir, agentId);
}

/**
 * Git prefers `remote.origin.pushurl` over `remote.origin.url` for pushes.
 * Desktop/local proxy sessions can leave an ephemeral localhost pushurl behind,
 * causing later `git push` calls to fail even after origin.url is repaired.
 *
 * For memfs repos, origin should always push to origin.url; mirrors are managed
 * separately through `letta.memoryRepository.url` and the post-commit hook.
 */
async function clearOriginPushUrl(
  repoDir: string,
  agentId: string,
): Promise<void> {
  let pushUrls: string[] = [];
  try {
    const { stdout } = await runGit(repoDir, [
      "config",
      "--local",
      "--get-all",
      "remote.origin.pushurl",
    ]);
    pushUrls = stdout
      .split("\n")
      .map((url) => url.trim())
      .filter(Boolean);
  } catch {
    // No pushurl configured — origin.url will be used for pushes.
    return;
  }

  if (pushUrls.length === 0) {
    return;
  }

  await runGit(repoDir, [
    "config",
    "--local",
    "--unset-all",
    "remote.origin.pushurl",
  ]);

  debugLog(
    "memfs-git",
    `Cleared origin pushurl for ${agentId}: ${pushUrls.join(", ")}`,
  );
}

/** Git remote URL for the agent's state repo */
function getMemoryRemoteUrl(agentId: string): string {
  return getGitRemoteUrl(agentId);
}

/**
 * Get a fresh auth token for git operations.
 * Reuses the same token resolution flow as getClient()
 * (env var → settings → OAuth refresh).
 */
async function getAuthToken(): Promise<string> {
  const { getBackend } = await import("@/backend");
  const backend = getBackend();
  if (backend.capabilities.localMemfs && !backend.capabilities.remoteMemfs) {
    return "";
  }

  const client = await getClient();
  // The client constructor resolves the token; extract it
  // biome-ignore lint/suspicious/noExplicitAny: accessing internal client options
  return (client as any)._options?.apiKey ?? "";
}

/**
 * Header sent on every git smart-HTTP request so cloud-api can route this
 * agent's repo through hosted MemFS instead of the default memfs-py path.
 *
 * Opt-in via `LETTA_MEMFS_BACKEND=hosted` in the letta-code process env.
 * If unset (or set to anything else), no header is added and cloud-api
 * falls through to the existing Python proxy.
 */
const HOSTED_BACKEND_HEADER = "x-letta-memfs-backend";
const HOSTED_BACKEND_VALUE = "hosted";

function isHostedBackendRequested(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.LETTA_MEMFS_BACKEND === HOSTED_BACKEND_VALUE;
}

export function buildGitAuthArgs(
  token: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const args = [
    "-c",
    "credential.helper=",
    "-c",
    "core.askPass=",
    "-c",
    `http.extraHeader=Authorization: Basic ${Buffer.from(`letta:${token}`).toString("base64")}`,
  ];
  if (isHostedBackendRequested(env)) {
    args.push(
      "-c",
      `http.extraHeader=${HOSTED_BACKEND_HEADER}: ${HOSTED_BACKEND_VALUE}`,
    );
  }
  return args;
}

export function isMemfsGitNetworkCommand(args: string[]): boolean {
  return ["clone", "fetch", "pull", "push"].includes(args[0] ?? "");
}

export function buildMemfsGitProxyArgs(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!isMemfsGitNetworkCommand(args)) {
    return [];
  }

  const rewrite = getMemfsGitProxyRewriteConfig(env);
  if (!rewrite) {
    return [];
  }

  return ["-c", `${rewrite.configKey}=${rewrite.configValue}`];
}

export function shouldConfigurePersistentMemfsCredentialHelper(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return getMemfsGitProxyRewriteConfig(env) === null;
}

export function buildNonInteractiveGitEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
  };
}

/**
 * Run a git command in the given directory.
 * If a token is provided, passes it as an auth header.
 */
const GIT_DEFAULT_TIMEOUT_MS = 60_000; // 60s
const GIT_CLONE_TIMEOUT_MS = 180_000; // 3min — clone can be slow on cold CI runners

async function runGit(
  cwd: string,
  args: string[],
  token?: string,
  options?: { timeoutMs?: number },
): Promise<{ stdout: string; stderr: string }> {
  const authArgs = token ? buildGitAuthArgs(token) : [];
  const allArgs = [...buildMemfsGitProxyArgs(args), ...authArgs, ...args];

  // Redact credential helper values to avoid leaking tokens in debug logs.
  let loggableArgs = args;
  if (
    args[0] === "config" &&
    typeof args[1] === "string" &&
    args[1].includes("credential") &&
    args[1].includes(".helper")
  ) {
    loggableArgs = [args[0], args[1], "<redacted>"];
  } else if (args[0] === "push") {
    loggableArgs = args.map(redactCredentialedHttpsUrl);
  }
  debugLog("memfs-git", `git ${loggableArgs.join(" ")} (in ${cwd})`);

  const timeoutMs = options?.timeoutMs ?? GIT_DEFAULT_TIMEOUT_MS;
  let result: Awaited<ReturnType<typeof execFile>>;
  try {
    result = await execFile("git", allArgs, {
      cwd,
      env: buildNonInteractiveGitEnv(),
      maxBuffer: 10 * 1024 * 1024, // 10MB
      timeout: timeoutMs,
    });
  } catch (error) {
    throw redactGitAuthError(error);
  }

  return {
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
  };
}

/**
 * Returns true when a git error looks transient/retryable (network/edge).
 *
 * These failures are commonly seen when Cloudflare returns temporary 52x
 * errors during memfs clone/pull operations.
 */
export function isRetryableGitTransientError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  if (RETRYABLE_GIT_HTTP_ERROR_RE.test(message)) {
    return true;
  }

  // Git often emits both lines together:
  // - "error: RPC failed; HTTP 520 ..."
  // - "fatal: the remote end hung up unexpectedly"
  if (
    message.includes("RPC failed") &&
    RETRYABLE_GIT_NETWORK_ERROR_RE.test(message)
  ) {
    return true;
  }

  return false;
}

export function isMissingCwdGitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return MISSING_CWD_GIT_ERROR_RE.test(message);
}

async function runGitWithRetry(
  cwd: string,
  args: string[],
  token?: string,
  options?: {
    operation?: string;
    attempts?: number;
    baseDelayMs?: number;
    timeoutMs?: number;
  },
): Promise<{ stdout: string; stderr: string }> {
  const attempts = options?.attempts ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 500;
  const operation = options?.operation ?? args[0] ?? "git op";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // Self-heal against transient cwd removal races.
      if (!existsSync(cwd)) {
        mkdirSync(cwd, { recursive: true });
      }
      return await runGit(cwd, args, token, {
        timeoutMs: options?.timeoutMs,
      });
    } catch (error) {
      if (isMissingCwdGitError(error)) {
        // Recreate cwd and retry once through the normal loop.
        mkdirSync(cwd, { recursive: true });
        if (attempt < attempts) {
          continue;
        }
      }

      if (!isRetryableGitTransientError(error) || attempt >= attempts) {
        throw error;
      }

      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      const msg = redactGitAuthInText(
        error instanceof Error ? error.message : String(error),
      );
      debugWarn(
        "memfs-git",
        `${operation} failed with transient error (attempt ${attempt}/${attempts}): ${msg}. Retrying in ${delayMs}ms`,
      );

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // Should never be reached (loop either returns or throws).
  throw new Error(`Unexpected retry loop exit for ${operation}`);
}

/**
 * Configure a local credential helper in the repo's .git/config
 * so plain `git push` / `git pull` work without auth prefixes.
 * Skipped in Desktop proxy transport mode because the listener only has a
 * local session token; persisting that token under api.letta.com would break
 * normal CLI/TUI sessions that share the same memory repo.
 *
 * On Windows, we write a batch script because the bash-style inline
 * helper (`!f() { ... }; f`) doesn't work in PowerShell/cmd.
 */
async function configureLocalCredentialHelper(
  dir: string,
  token: string,
): Promise<void> {
  const rawBaseUrl = getMemfsServerUrl();
  const normalizedBaseUrl = normalizeCredentialBaseUrl(rawBaseUrl);

  if (!shouldConfigurePersistentMemfsCredentialHelper()) {
    await clearLocalCredentialHelper(dir, rawBaseUrl, normalizedBaseUrl);
    debugLog(
      "memfs-git",
      `Skipped persistent credential helper for ${normalizedBaseUrl}; using transient MemFS git proxy transport`,
    );
    return;
  }

  let helper: string;

  if (platform() === "win32") {
    // Windows: write a batch script to .git/ and reference it
    const helperScriptPath = join(dir, ".git", "letta-credential-helper.cmd");
    const batchScript = `@echo off
echo username=letta
echo password=${token}
`;
    writeFileSync(helperScriptPath, batchScript, "utf-8");
    // Use a normalized path and escape whitespace for profiles like "Jane Doe".
    helper = formatGitCredentialHelperPath(helperScriptPath);
    debugLog("memfs-git", `Wrote Windows credential helper script`);
  } else {
    // Unix/macOS: use inline bash helper
    helper = `!f() { echo "username=letta"; echo "password=${token}"; }; f`;
  }

  // Primary config: normalized origin key (most robust for git's credential lookup)
  await runGit(dir, [
    "config",
    `credential.${normalizedBaseUrl}.helper`,
    helper,
  ]);

  // Backcompat: also set raw configured URL key if it differs (older repos/configs)
  if (rawBaseUrl !== normalizedBaseUrl) {
    await runGit(dir, ["config", `credential.${rawBaseUrl}.helper`, helper]);
  }

  debugLog(
    "memfs-git",
    `Configured local credential helper for ${normalizedBaseUrl}${rawBaseUrl !== normalizedBaseUrl ? ` (and raw ${rawBaseUrl})` : ""}`,
  );
}

async function clearLocalCredentialHelper(
  dir: string,
  rawBaseUrl: string,
  normalizedBaseUrl: string,
): Promise<void> {
  const keys = new Set([
    `credential.${normalizedBaseUrl}.helper`,
    `credential.${rawBaseUrl}.helper`,
  ]);

  for (const key of keys) {
    try {
      await runGit(dir, ["config", "--local", "--unset-all", key]);
    } catch {
      // Already unset — ignore.
    }
  }
}

/**
 * Bash pre-commit hook that validates frontmatter in memory .md files.
 *
 * Rules:
 * - Frontmatter is REQUIRED (must start with ---)
 * - Must be properly closed with ---
 * - Required fields: description (non-empty string)
 * - read_only is a PROTECTED field: agent cannot add, remove, or change it.
 *   Files where HEAD has read_only: true cannot be modified at all.
 * - Only allowed agent-editable key: description
 * - Legacy key 'limit' is tolerated for backward compatibility
 * - read_only may exist (from server) but agent must not change it
 */
export const PRE_COMMIT_HOOK_SCRIPT = `#!/usr/bin/env bash
# Validate frontmatter in staged memory .md files
# Installed by Letta Code CLI

AGENT_EDITABLE_KEYS="description"
PROTECTED_KEYS="read_only"
ALL_KNOWN_KEYS="description read_only limit"
errors=""

# Skills must always be directories: skills/<name>/SKILL.md
# Reject legacy flat skill files (both current and legacy repo layouts).
for file in $(git diff --cached --name-only --diff-filter=ACMR | grep -E '^(memory/)?skills/[^/]+\\.md$' || true); do
  errors="$errors\\n  $file: invalid skill path (skills must be folders). Use skills/<name>/SKILL.md"
done

# Helper: extract a frontmatter value from content
get_fm_value() {
  local content="$1" key="$2"
  local closing_line
  closing_line=$(echo "$content" | tail -n +2 | grep -n '^---$' | head -1 | cut -d: -f1)
  [ -z "$closing_line" ] && return
  echo "$content" | tail -n +2 | head -n $((closing_line - 1)) | grep "^$key:" | cut -d: -f2- | sed 's/^ *//;s/ *$//'
}

# Match .md files under system/ or reference/ (with optional memory/ prefix).
# Skip skill SKILL.md files — they use a different frontmatter format.
for file in $(git diff --cached --name-only --diff-filter=ACM | grep -E '^(memory/)?(system|reference)/.*\\.md$'); do
  staged=$(git show ":$file")

  # Frontmatter is required
  first_line=$(echo "$staged" | head -1)
  if [ "$first_line" != "---" ]; then
    errors="$errors\\n  $file: missing frontmatter (must start with ---)"
    continue
  fi

  # Check frontmatter is properly closed
  closing_line=$(echo "$staged" | tail -n +2 | grep -n '^---$' | head -1 | cut -d: -f1)
  if [ -z "$closing_line" ]; then
    errors="$errors\\n  $file: frontmatter opened but never closed (missing closing ---)"
    continue
  fi

  # Check read_only protection against HEAD version
  head_content=$(git show "HEAD:$file" 2>/dev/null || true)
  if [ -n "$head_content" ]; then
    head_ro=$(get_fm_value "$head_content" "read_only")
    if [ "$head_ro" = "true" ]; then
      errors="$errors\\n  $file: file is read_only and cannot be modified"
      continue
    fi
  fi

  # Extract frontmatter lines
  frontmatter=$(echo "$staged" | tail -n +2 | head -n $((closing_line - 1)))

  # Track required fields
  has_description=false

  # Validate each line
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    # Skip YAML multiline continuation lines (indented lines that continue a previous value)
    case "$line" in
      " "*|$'\t'*) continue ;;
    esac

    key=$(echo "$line" | cut -d: -f1 | tr -d ' ')
    value=$(echo "$line" | cut -d: -f2- | sed 's/^ *//;s/ *$//')

    # Check key is known
    known=false
    for k in $ALL_KNOWN_KEYS; do
      if [ "$key" = "$k" ]; then
        known=true
        break
      fi
    done
    if [ "$known" = "false" ]; then
      errors="$errors\\n  $file: unknown frontmatter key '$key' (allowed: $ALL_KNOWN_KEYS)"
      continue
    fi

    # Check if agent is trying to modify a protected key
    for k in $PROTECTED_KEYS; do
      if [ "$key" = "$k" ]; then
        # Compare against HEAD — if value changed (or key was added), reject
        if [ -n "$head_content" ]; then
          head_val=$(get_fm_value "$head_content" "$key")
          if [ "$value" != "$head_val" ]; then
            errors="$errors\\n  $file: '$key' is a protected field and cannot be changed by the agent"
          fi
        else
          # New file with read_only — agent shouldn't set this
          errors="$errors\\n  $file: '$key' is a protected field and cannot be set by the agent"
        fi
      fi
    done

    # Validate value types
    case "$key" in
      limit)
        # Legacy field accepted for backward compatibility.
        ;;
      description)
        has_description=true
        if [ -z "$value" ]; then
          errors="$errors\\n  $file: 'description' must not be empty"
        fi
        ;;
    esac
  done <<< "$frontmatter"

  # Check required fields
  if [ "$has_description" = "false" ]; then
    errors="$errors\\n  $file: missing required field 'description'"
  fi

  # Check if protected keys were removed (existed in HEAD but not in staged)
  if [ -n "$head_content" ]; then
    for k in $PROTECTED_KEYS; do
      head_val=$(get_fm_value "$head_content" "$k")
      if [ -n "$head_val" ]; then
        staged_val=$(get_fm_value "$staged" "$k")
        if [ -z "$staged_val" ]; then
          errors="$errors\\n  $file: '$k' is a protected field and cannot be removed by the agent"
        fi
      fi
    done
  fi
done

if [ -n "$errors" ]; then
  echo "Frontmatter validation failed:"
  echo -e "$errors"
  exit 1
fi
`;

/**
 * Install the pre-commit hook for frontmatter validation.
 */
function installPreCommitHook(dir: string): void {
  const hooksDir = join(dir, ".git", "hooks");
  const hookPath = join(hooksDir, "pre-commit");

  if (!existsSync(hooksDir)) {
    mkdirSync(hooksDir, { recursive: true });
  }

  writeFileSync(hookPath, PRE_COMMIT_HOOK_SCRIPT, "utf-8");
  chmodSync(hookPath, 0o755);
  debugLog("memfs-git", "Installed pre-commit hook");
}

/**
 * Bash post-commit hook that pushes memfs commits to an optional additional
 * git remote (the "memory repository" endpoint).
 *
 * Reads the remote URL from the repo's local git config
 * (`letta.memoryRepository.url`). No-op when the key is unset. Push runs
 * asynchronously in the background so commits stay fast, and failures are
 * logged to `.git/memory-repository-push.log` without blocking the user.
 *
 * URL is per-repo by design: each agent's memfs repo has its own `.git/config`,
 * so the endpoint is scoped to a single agent automatically.
 */
export const POST_COMMIT_HOOK_SCRIPT = `#!/usr/bin/env bash
# Letta Code: push memfs commits to the configured memory-repository remote.
# Installed by Letta Code CLI. Do not edit by hand — regenerated on startup.
url=$(git config --local --get letta.memoryRepository.url 2>/dev/null)
[ -z "$url" ] && exit 0
branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null) || exit 0
[ -z "$branch" ] && exit 0
# Reflection and other harness worktrees commit on temporary branches; only the
# main MemFS checkout should push to the optional memory repository remote.
[ "$branch" != "main" ] && exit 0
log="$(git rev-parse --git-dir)/memory-repository-push.log"
(
  {
    printf '\\n--- %s %s on %s ---\\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$(git rev-parse --short HEAD)" "$branch"
    git push --quiet "$url" "$branch":"$branch" 2>&1
    echo "exit=$?"
  } >> "$log" 2>&1
) &
disown 2>/dev/null || true
exit 0
`;

/**
 * Install the post-commit hook that pushes to `letta.memoryRepository.url`.
 * Hook is harmless when the config key is unset (no-ops on every commit).
 */
function installPostCommitHook(dir: string): void {
  const hooksDir = join(dir, ".git", "hooks");
  const hookPath = join(hooksDir, "post-commit");

  if (!existsSync(hooksDir)) {
    mkdirSync(hooksDir, { recursive: true });
  }

  writeFileSync(hookPath, POST_COMMIT_HOOK_SCRIPT, "utf-8");
  chmodSync(hookPath, 0o755);
  debugLog("memfs-git", "Installed post-commit memory-repository hook");
}

/**
 * Read a local-scoped git config value. Returns null when the key is unset.
 */
async function getLocalGitConfig(
  dir: string,
  key: string,
): Promise<string | null> {
  try {
    const { stdout } = await runGit(dir, ["config", "--local", "--get", key]);
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    // Unset keys cause git to exit non-zero — treat as "null".
    return null;
  }
}

/** Set a local-scoped git config value. */
async function setLocalGitConfig(
  dir: string,
  key: string,
  value: string,
): Promise<void> {
  await runGit(dir, ["config", "--local", key, value]);
}

/** Unset a local-scoped git config value. Ignores "not set" errors. */
async function unsetLocalGitConfig(dir: string, key: string): Promise<void> {
  try {
    await runGit(dir, ["config", "--local", "--unset", key]);
  } catch {
    // Already unset — ignore.
  }
}

/**
 * Best-effort lookup of the agent's display name via the API.
 * Returns null if the call fails for any reason — we don't want config setup
 * to block memfs startup.
 */
async function fetchAgentDisplayName(agentId: string): Promise<string | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const { getBackend } = await import("@/backend");
    const agent = await Promise.race([
      getBackend().retrieveAgent(agentId),
      new Promise<null>((resolve) => {
        timeout = setTimeout(
          () => resolve(null),
          AGENT_DISPLAY_NAME_TIMEOUT_MS,
        );
      }),
    ]);
    if (!agent) {
      debugWarn(
        "memfs-git",
        `Timed out fetching agent display name after ${AGENT_DISPLAY_NAME_TIMEOUT_MS}ms`,
      );
      return null;
    }
    const name = (agent.name ?? "").trim();
    return name.length > 0 ? name : null;
  } catch (err) {
    debugWarn(
      "memfs-git",
      `Failed to fetch agent display name: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

/**
 * Ensure the memfs repo has canonical local git config:
 *   - `letta.agentId` reconciled to the current agent id (always)
 *   - `user.email` = `<agentId>@letta.com` (only if unset — user overrides preserved)
 *   - `user.name`  = agent display name (only if unset — user overrides preserved)
 *
 * Without this, direct `git commit` from the agent's shell falls back to the
 * operator's global git identity (e.g. "Sarah Wooders"), producing mixed
 * attribution in `git log`. The memory tool path already passes explicit
 * `-c user.name=.. -c user.email=..` overrides, so it's unaffected.
 */
export async function ensureLocalMemfsGitConfig(
  dir: string,
  agentId: string,
): Promise<void> {
  if (!existsSync(join(dir, ".git"))) {
    return;
  }

  try {
    // Always reconcile — cheap and idempotent.
    const currentAgentId = await getLocalGitConfig(dir, "letta.agentId");
    if (currentAgentId !== agentId) {
      await setLocalGitConfig(dir, "letta.agentId", agentId);
    }

    // Respect user overrides: only set identity when unset locally.
    const currentEmail = await getLocalGitConfig(dir, "user.email");
    if (!currentEmail) {
      await setLocalGitConfig(dir, "user.email", `${agentId}@letta.com`);
    }

    const currentName = await getLocalGitConfig(dir, "user.name");
    if (!currentName) {
      const displayName =
        (await fetchAgentDisplayName(agentId)) ?? "Letta Agent";
      await setLocalGitConfig(dir, "user.name", displayName);
    }
  } catch (err) {
    // Identity config is nice-to-have; never block memfs startup on it.
    debugWarn(
      "memfs-git",
      `Failed to ensure local memfs git config: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Memory repository (/memory-repository slash command helpers)
 *
 * The remote URL lives in each repo's local `.git/config` under
 * `letta.memoryRepository.url`. The post-commit hook reads that key and
 * pushes to it in the background after every commit.
 * See `POST_COMMIT_HOOK_SCRIPT`.
 * ------------------------------------------------------------------ */

const MEMORY_REPOSITORY_CONFIG_KEY = "letta.memoryRepository.url";
const MEMORY_REPOSITORY_PUSH_LOG = "memory-repository-push.log";

/** Return the currently-configured memory-repository URL for this agent, or null. */
export async function getMemoryRepositoryUrl(
  agentId: string,
): Promise<string | null> {
  const dir = getMemoryRepositoryRepoDir(agentId);
  if (!existsSync(join(dir, ".git"))) {
    return null;
  }
  return await getLocalGitConfig(dir, MEMORY_REPOSITORY_CONFIG_KEY);
}

/**
 * Configure a memory-repository URL for this agent's memfs repo.
 * Re-installs the post-commit hook defensively so that prior manual edits
 * or stale state don't cause silent push drops.
 */
export async function setMemoryRepositoryUrl(
  agentId: string,
  url: string,
): Promise<void> {
  const dir = getMemoryRepositoryRepoDir(agentId);
  if (!existsSync(join(dir, ".git"))) {
    throw new Error(
      `Memory repo not initialized for ${agentId} — cannot configure memory-repository endpoint.`,
    );
  }
  await setLocalGitConfig(dir, MEMORY_REPOSITORY_CONFIG_KEY, url.trim());
  installPostCommitHook(dir);
}

/** Remove the memory-repository URL configuration for this agent. */
export async function unsetMemoryRepositoryUrl(agentId: string): Promise<void> {
  const dir = getMemoryRepositoryRepoDir(agentId);
  if (!existsSync(join(dir, ".git"))) {
    return;
  }
  await unsetLocalGitConfig(dir, MEMORY_REPOSITORY_CONFIG_KEY);
}

export interface MemoryRepositoryPushResult {
  ok: boolean;
  url: string | null;
  branch: string | null;
  output: string;
}

/**
 * One-shot push to the memory-repository remote. Used by
 * `/memory-repository push` to retry after a failure or to do an initial push
 * without waiting for the next commit.
 */
export async function pushToMemoryRepository(
  agentId: string,
): Promise<MemoryRepositoryPushResult> {
  const dir = getMemoryRepositoryRepoDir(agentId);
  const url = await getMemoryRepositoryUrl(agentId);
  if (!url) {
    return {
      ok: false,
      url: null,
      branch: null,
      output:
        "No memory-repository URL configured. Use /memory-repository set <url> to configure one.",
    };
  }

  try {
    await runGit(dir, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    // Fresh repo with no commits — nothing to push.
    return {
      ok: false,
      url,
      branch: null,
      output:
        "Memory repo has no commits yet — nothing to push. Make a change and commit first.",
    };
  }

  let branch: string;
  try {
    const { stdout } = await runGit(dir, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
    branch = stdout.trim();
    if (!branch) {
      throw new Error("empty branch name");
    }
  } catch {
    return {
      ok: false,
      url,
      branch: null,
      output:
        "Memory repo is in a detached HEAD state — check out a branch before pushing.",
    };
  }

  try {
    const { stdout, stderr } = await runGit(dir, [
      "push",
      url,
      `${branch}:${branch}`,
    ]);
    return {
      ok: true,
      url,
      branch,
      output: (stdout + stderr).trim() || "Pushed (no output).",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, url, branch, output: msg };
  }
}

/**
 * Return the tail of the memory-repository push log.
 * Used by `/memory-repository status`.
 */
export function readMemoryRepositoryPushLog(
  agentId: string,
  tailLines: number = 20,
): string {
  const logPath = join(
    getMemoryRepositoryRepoDir(agentId),
    ".git",
    MEMORY_REPOSITORY_PUSH_LOG,
  );
  if (!existsSync(logPath)) {
    return "";
  }
  try {
    const content = readFileSync(logPath, "utf-8");
    const lines = content.split("\n");
    return lines.slice(-tailLines).join("\n");
  } catch {
    return "";
  }
}

function normalizePathspecs(pathspecs: string[]): string[] {
  return Array.from(new Set(pathspecs)).filter(
    (path) => path.trim().length > 0,
  );
}

function isNonFastForwardPushError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return NON_FAST_FORWARD_PUSH_ERROR_RE.test(message);
}

function isRecoverableMemoryPullHistoryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    UNRELATED_HISTORY_PULL_ERROR_RE.test(message) ||
    NO_UPSTREAM_PULL_ERROR_RE.test(message)
  );
}

async function prepareMemoryRepoForGitOps(
  memoryDir: string,
  agentId: string,
  token: string,
): Promise<void> {
  await maybeUpdateMemoryRemoteOrigin(memoryDir, agentId);
  await configureLocalCredentialHelper(memoryDir, token);
  installPreCommitHook(memoryDir);
  installPostCommitHook(memoryDir);
  await ensureLocalMemfsGitConfig(memoryDir, agentId);
}

async function recoverMemoryPullByResettingToRemote(
  memoryDir: string,
  token: string,
): Promise<string> {
  const { stdout: status } = await runGit(memoryDir, ["status", "--porcelain"]);
  if (status.trim()) {
    throw new Error(
      "Local memory repo has uncommitted changes; refusing to auto-reset unrelated history.",
    );
  }

  await runGitWithRetry(memoryDir, ["fetch", "origin", "main"], token, {
    operation: "fetch memory repo for reset",
  });

  const { stdout: remoteShaOut } = await runGit(memoryDir, [
    "rev-parse",
    "--verify",
    "refs/remotes/origin/main",
  ]);
  const remoteSha = remoteShaOut.trim();
  if (!remoteSha) {
    throw new Error("Remote memory repo did not advertise origin/main.");
  }

  let backupRef: string | null = null;
  try {
    const { stdout: localShaOut } = await runGit(memoryDir, [
      "rev-parse",
      "--verify",
      "HEAD",
    ]);
    const localSha = localShaOut.trim();
    if (localSha && localSha !== remoteSha) {
      backupRef = `refs/letta-backup/pre-sync-${Date.now()}`;
      await runGit(memoryDir, ["update-ref", backupRef, localSha]);
    }
  } catch {
    // No local HEAD to preserve.
  }

  await runGit(memoryDir, ["reset", "--hard", "refs/remotes/origin/main"]);
  try {
    await runGit(memoryDir, [
      "branch",
      "--set-upstream-to",
      "origin/main",
      "main",
    ]);
  } catch {
    // Non-fatal; future explicit git commands can still name origin/main.
  }

  return backupRef
    ? `Recovered memory repo by resetting to origin/main (${remoteSha.slice(0, 7)}). Previous local HEAD was preserved at ${backupRef}.`
    : `Recovered memory repo by resetting to origin/main (${remoteSha.slice(0, 7)}).`;
}

async function hasMergeBaseWithUpstream(memoryDir: string): Promise<boolean> {
  try {
    await runGit(memoryDir, ["merge-base", "HEAD", "@{u}"]);
    return true;
  } catch {
    return false;
  }
}

async function prepareLocalOnlyMemoryRepoForGitOps(
  memoryDir: string,
  author: MemoryCommitAuthor,
): Promise<void> {
  installPreCommitHook(memoryDir);
  installPostCommitHook(memoryDir);
  await setLocalGitConfig(memoryDir, "letta.agentId", author.agentId);
  await setLocalGitConfig(memoryDir, "user.email", author.authorEmail);
  await setLocalGitConfig(
    memoryDir,
    "user.name",
    author.authorName.trim() || "Letta Agent",
  );
}

async function stageMemoryPaths(
  memoryDir: string,
  pathspecs: string[],
): Promise<void> {
  if (pathspecs.length === 0) {
    return;
  }
  await runGit(memoryDir, ["add", "-A", "--", ...pathspecs]);
}

async function hasStagedMemoryChanges(
  memoryDir: string,
  pathspecs: string[],
): Promise<boolean> {
  if (pathspecs.length === 0) {
    return false;
  }

  const status = await runGit(memoryDir, [
    "status",
    "--porcelain",
    "--",
    ...pathspecs,
  ]);
  return status.stdout.trim().length > 0;
}

async function commitMemoryPaths(
  memoryDir: string,
  pathspecs: string[],
  reason: string,
  author: MemoryCommitAuthor,
): Promise<{ committed: boolean; sha?: string }> {
  const normalizedPathspecs = normalizePathspecs(pathspecs);
  await stageMemoryPaths(memoryDir, normalizedPathspecs);

  if (!(await hasStagedMemoryChanges(memoryDir, normalizedPathspecs))) {
    return { committed: false };
  }

  try {
    await runGit(memoryDir, [
      "-c",
      `user.name=${author.authorName.trim() || author.agentId}`,
      "-c",
      `user.email=${author.authorEmail}`,
      "commit",
      "-m",
      reason,
    ]);
  } catch (error) {
    await unstageMemoryPaths(memoryDir, normalizedPathspecs);
    throw error;
  }

  const head = await runGit(memoryDir, ["rev-parse", "HEAD"]);
  return {
    committed: true,
    sha: head.stdout.trim(),
  };
}

async function unstageMemoryPaths(
  memoryDir: string,
  pathspecs: string[],
): Promise<void> {
  if (pathspecs.length === 0) {
    return;
  }

  try {
    await runGit(memoryDir, ["reset", "HEAD", "--", ...pathspecs]);
  } catch {
    // Best-effort cleanup only.
  }
}

export async function assertMemoryRepoCleanForWrite(
  memoryDir: string,
): Promise<void> {
  const status = await runGit(memoryDir, ["status", "--porcelain"]);
  if (status.stdout.trim().length > 0) {
    const encodingDetails = describeDirtyMarkdownEncodingIssues(
      memoryDir,
      status.stdout,
    );
    throw new Error(
      "Memory repo has uncommitted changes. Commit, discard, or sync them before using memory tools." +
        encodingDetails,
    );
  }
}

function describeDirtyMarkdownEncodingIssues(
  memoryDir: string,
  porcelainStatus: string,
): string {
  const issues = porcelainStatus
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map(parsePorcelainPath)
    .filter((path): path is string => path?.endsWith(".md") ?? false)
    .map((path) => describeMarkdownEncodingIssue(memoryDir, path))
    .filter((issue): issue is string => issue !== null);

  if (issues.length === 0) {
    return "";
  }

  return ` Dirty markdown encoding issue(s): ${issues.join("; ")}.`;
}

function parsePorcelainPath(line: string): string | null {
  if (line.length < 4) {
    return null;
  }

  const status = line.slice(0, 2);
  if (status === " D" || status === "D " || status === "DD") {
    return null;
  }

  const rawPath = line.slice(3);
  const renameSeparator = " -> ";
  const path = rawPath.includes(renameSeparator)
    ? (rawPath.split(renameSeparator).pop() ?? rawPath)
    : rawPath;

  return path.replace(/^"|"$/g, "");
}

function describeMarkdownEncodingIssue(
  memoryDir: string,
  relativePath: string,
): string | null {
  const filePath = join(memoryDir, relativePath);
  if (!existsSync(filePath)) {
    return null;
  }

  const bytes = readFileSync(filePath);
  const utf16Bom = getUtf16Bom(bytes);
  if (utf16Bom) {
    return `${relativePath} has ${utf16Bom} BOM`;
  }

  if (bytes.includes(0)) {
    return `${relativePath} contains NUL bytes, possibly UTF-16`;
  }

  return null;
}

export async function commitMemoryWrite(
  params: CommitMemoryWriteParams,
): Promise<CommitMemoryWriteResult> {
  const normalizedPathspecs = normalizePathspecs(params.pathspecs);
  if (normalizedPathspecs.length === 0) {
    return { committed: false };
  }

  if (params.syncMode === "local") {
    await prepareLocalOnlyMemoryRepoForGitOps(params.memoryDir, params.author);
    return commitMemoryPaths(
      params.memoryDir,
      normalizedPathspecs,
      params.reason,
      params.author,
    );
  }

  const token = await getAuthToken();
  await prepareMemoryRepoForGitOps(
    params.memoryDir,
    params.author.agentId,
    token,
  );

  const commitResult = await commitMemoryPaths(
    params.memoryDir,
    normalizedPathspecs,
    params.reason,
    params.author,
  );
  if (!commitResult.committed || !commitResult.sha) {
    return { committed: false };
  }

  return {
    committed: true,
    sha: commitResult.sha,
  };
}

/** Check if the memory directory is a git repo */
export function isGitRepo(agentId: string): boolean {
  return existsSync(join(getScopedMemoryFilesystemRoot(agentId), ".git"));
}

export interface InitializeLocalMemoryRepoFile {
  relativePath: string;
  content: string;
}

export interface InitializeLocalMemoryRepoParams {
  memoryDir: string;
  agentId: string;
  authorName?: string;
  files: InitializeLocalMemoryRepoFile[];
}

async function hasMemoryHead(memoryDir: string): Promise<boolean> {
  try {
    await runGit(memoryDir, ["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

export async function getMemoryHeadRevision(
  memoryDir: string,
): Promise<string | null> {
  try {
    const { stdout } = await runGit(memoryDir, [
      "rev-parse",
      "--verify",
      "HEAD",
    ]);
    const revision = stdout.trim();
    return revision.length > 0 ? revision : null;
  } catch {
    return null;
  }
}

export async function initializeLocalMemoryRepo(
  params: InitializeLocalMemoryRepoParams,
): Promise<void> {
  mkdirSync(params.memoryDir, { recursive: true });

  if (!existsSync(join(params.memoryDir, ".git"))) {
    await runGit(params.memoryDir, ["init"]);
    await runGit(params.memoryDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  }

  const author: MemoryCommitAuthor = {
    agentId: params.agentId,
    authorName: params.authorName?.trim() || "Letta Agent",
    authorEmail: `${params.agentId}@letta.com`,
  };
  await prepareLocalOnlyMemoryRepoForGitOps(params.memoryDir, author);

  if (await hasMemoryHead(params.memoryDir)) {
    return;
  }

  const pathspecs: string[] = [];
  for (const file of params.files) {
    const relativePath = file.relativePath.replace(/\\/g, "/");
    const segments = relativePath.split("/").filter(Boolean);
    if (
      !relativePath ||
      relativePath.startsWith("/") ||
      segments.length === 0 ||
      segments.some((segment) => segment === "." || segment === "..")
    ) {
      continue;
    }
    const fullPath = join(params.memoryDir, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, file.content, "utf8");
    pathspecs.push(relativePath);
  }

  if (pathspecs.length > 0) {
    const commit = await commitMemoryPaths(
      params.memoryDir,
      pathspecs,
      "chore: initialize local memory",
      author,
    );
    if (commit.committed) {
      return;
    }
  }

  await runGit(params.memoryDir, [
    "-c",
    `user.name=${author.authorName}`,
    "-c",
    `user.email=${author.authorEmail}`,
    "commit",
    "--allow-empty",
    "-m",
    "chore: initialize empty local memory",
  ]);
}

interface AgentRepositoryResponse {
  repositories: Array<{
    id: string;
    name: string;
    is_primary: boolean;
  }>;
}

export interface AttachedAgentRepository {
  id: string;
  name: string;
}

export interface SyncAgentRepositoriesResult {
  mounted: number;
  skipped: number;
  failed: number;
  summaries: string[];
}

async function listAttachedAgentRepositories(
  agentId: string,
): Promise<AttachedAgentRepository[]> {
  const response = await apiRequest<AgentRepositoryResponse>(
    "GET",
    `/v1/agents/${encodeURIComponent(agentId)}/repositories`,
  );
  return response.repositories
    .filter(
      (repository) => !repository.is_primary && repository.name !== "memory",
    )
    .map((repository) => ({
      id: repository.id,
      name: repository.name,
    }));
}

async function syncAttachedRepository(args: {
  agentId: string;
  repositoryName: string;
  token: string;
}): Promise<string> {
  const repositoryName = validateAgentRepositoryName(args.repositoryName);
  const directory = getRepositoryMountDir(args.agentId, repositoryName);
  const remoteUrl = getRepositoryRemoteUrl(args.agentId, repositoryName);

  await cloneRepositoryMount({
    agentId: args.agentId,
    repositoryName,
    directory,
    remoteUrl,
    token: args.token,
  });
  return `${repositoryName}: ${directory}`;
}

export async function syncAttachedAgentRepositories(
  agentId: string,
): Promise<SyncAgentRepositoriesResult> {
  let repositories: Awaited<ReturnType<typeof listAttachedAgentRepositories>>;
  try {
    repositories = await listAttachedAgentRepositories(agentId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    debugWarn(
      "memfs-git",
      `Failed to list attached repositories for ${agentId}: ${message}`,
    );
    return {
      mounted: 0,
      skipped: 0,
      failed: 1,
      summaries: [`Failed to list attached repositories: ${message}`],
    };
  }

  if (repositories.length === 0) {
    return { mounted: 0, skipped: 0, failed: 0, summaries: [] };
  }

  const token = await getAuthToken();
  const results = await Promise.allSettled(
    repositories.map((repository) =>
      syncAttachedRepository({
        agentId,
        repositoryName: repository.name,
        token,
      }),
    ),
  );

  const summaries: string[] = [];
  let mounted = 0;
  let failed = 0;

  for (let index = 0; index < results.length; index += 1) {
    const repository = repositories[index];
    if (!repository) continue;
    const result = results[index];
    if (!result) continue;
    if (result.status === "fulfilled") {
      mounted += 1;
      summaries.push(result.value);
    } else {
      failed += 1;
      const message =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
      summaries.push(`${repository.name}: failed: ${message}`);
      debugWarn(
        "memfs-git",
        `Failed to sync attached repository ${repository.name}: ${message}`,
      );
    }
  }

  return { mounted, skipped: 0, failed, summaries };
}

/**
 * Clone the agent's state repo into the memory directory.
 *
 * Git root is ~/.letta/agents/{id}/memory/ (not the agent root).
 */
export async function cloneMemoryRepo(agentId: string): Promise<void> {
  const token = await getAuthToken();
  const url = getMemoryRemoteUrl(agentId);
  const dir = getMemoryRepoDir(agentId);

  debugLog("memfs-git", `Cloning ${url} → ${dir}`);

  if (!existsSync(dir)) {
    // Fresh clone into new memory directory
    mkdirSync(dir, { recursive: true });
    await runGitWithRetry(dir, ["clone", url, "."], token, {
      operation: "clone memory repo",
      timeoutMs: GIT_CLONE_TIMEOUT_MS,
    });
  } else if (!existsSync(join(dir, ".git"))) {
    // Directory exists but isn't a git repo (legacy local layout)
    // Clone to temp, move .git/ into existing dir, then checkout files.
    const tmpDir = `${dir}-git-clone-tmp`;
    try {
      if (existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
      mkdirSync(tmpDir, { recursive: true });
      await runGitWithRetry(tmpDir, ["clone", url, "."], token, {
        operation: "clone memory repo (tmp migration)",
        timeoutMs: GIT_CLONE_TIMEOUT_MS,
      });

      // Move .git into the existing memory directory
      renameSync(join(tmpDir, ".git"), join(dir, ".git"));

      // Reset to match remote state. Skip when the remote has no HEAD
      // yet (empty repo, e.g. a freshly-allocated training agent) —
      // `git checkout -- .` fails with "pathspec '.' did not match any
      // file(s) known to git" in that case, which is fatal here. When
      // there's nothing on the remote there's nothing to restore, so
      // leaving the existing local files in place is the right move.
      try {
        await runGit(dir, ["rev-parse", "--verify", "HEAD"], token);
        await runGit(dir, ["checkout", "--", "."], token);
      } catch (checkoutErr) {
        const msg =
          checkoutErr instanceof Error
            ? checkoutErr.message
            : String(checkoutErr);
        debugLog(
          "memfs-git",
          `Skipping checkout (likely empty remote, no HEAD yet): ${msg}`,
        );
      }

      debugLog("memfs-git", "Migrated existing memory directory to git repo");
    } finally {
      if (existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  }

  // Configure local credential helper so the agent can do plain
  // `git push` / `git pull` without auth prefixes.
  await configureLocalCredentialHelper(dir, token);

  // Install commit hooks (pre-commit validates frontmatter; post-commit mirrors)
  installPreCommitHook(dir);
  installPostCommitHook(dir);

  // Set canonical local git identity (letta.agentId, user.email, user.name)
  await ensureLocalMemfsGitConfig(dir, agentId);

  await syncAttachedAgentRepositories(agentId);
}

/**
 * Pull latest changes from the server.
 * Called on startup to ensure local state is current.
 */
export interface PullMemoryOptions {
  throwOnFailure?: boolean;
}

export async function pullMemory(
  agentId: string,
  options: PullMemoryOptions = {},
): Promise<{ updated: boolean; summary: string }> {
  const token = await getAuthToken();
  const dir = getMemoryRepoDir(agentId);

  await maybeUpdateMemoryRemoteOrigin(dir, agentId);

  // Self-healing: ensure credential helper, hooks, and identity config are current
  await configureLocalCredentialHelper(dir, token);
  installPreCommitHook(dir);
  installPostCommitHook(dir);
  await ensureLocalMemfsGitConfig(dir, agentId);

  try {
    const { stdout, stderr } = await runGitWithRetry(
      dir,
      ["pull", "--ff-only"],
      token,
      { operation: "pull --ff-only" },
    );
    const output = stdout + stderr;
    const updated = !output.includes("Already up to date");
    await syncAttachedAgentRepositories(agentId);
    return {
      updated,
      summary: updated ? output.trim() : "Already up to date",
    };
  } catch {
    if (!(await hasMergeBaseWithUpstream(dir))) {
      try {
        const summary = await recoverMemoryPullByResettingToRemote(dir, token);
        await syncAttachedAgentRepositories(agentId);
        return {
          updated: true,
          summary,
        };
      } catch (recoverErr) {
        const recoverMsg =
          recoverErr instanceof Error ? recoverErr.message : String(recoverErr);
        debugWarn(
          "memfs-git",
          `Automatic memory repo reset failed: ${recoverMsg}`,
        );
      }
    }

    // If ff-only fails (diverged), try rebase
    debugWarn("memfs-git", "Fast-forward pull failed, trying rebase");
    try {
      const { stdout, stderr } = await runGitWithRetry(
        dir,
        ["pull", "--rebase"],
        token,
        { operation: "pull --rebase" },
      );
      await syncAttachedAgentRepositories(agentId);
      return { updated: true, summary: (stdout + stderr).trim() };
    } catch (rebaseErr) {
      if (isRecoverableMemoryPullHistoryError(rebaseErr)) {
        try {
          const summary = await recoverMemoryPullByResettingToRemote(
            dir,
            token,
          );
          await syncAttachedAgentRepositories(agentId);
          return {
            updated: true,
            summary,
          };
        } catch (recoverErr) {
          const recoverMsg =
            recoverErr instanceof Error
              ? recoverErr.message
              : String(recoverErr);
          debugWarn(
            "memfs-git",
            `Automatic memory repo reset failed: ${recoverMsg}`,
          );
        }
      }

      const msg =
        rebaseErr instanceof Error ? rebaseErr.message : String(rebaseErr);
      const failureSummary = `Pull failed: ${msg}\nHint: verify remote and auth:\n- git -C ${dir} remote -v\n- git -C ${dir} config --get-regexp '^credential\\..*\\.helper$'`;
      debugWarn("memfs-git", `Pull failed: ${msg}`);
      if (options.throwOnFailure) {
        throw new Error(failureSummary);
      }
      return {
        updated: false,
        summary: failureSummary,
      };
    }
  }
}

/**
 * Push local memory commits to the server.
 * Keeps remote writes explicit: no automatic pull --rebase.
 */
export async function pushMemory(agentId: string): Promise<void> {
  const token = await getAuthToken();
  const dir = getMemoryRepoDir(agentId);

  await prepareMemoryRepoForGitOps(dir, agentId, token);
  await runGit(dir, ["push", "-u", "origin", "main"], token);
}

export interface MemoryGitStatus {
  /** Uncommitted changes in working tree */
  dirty: boolean;
  /** Local commits not pushed to remote */
  aheadOfRemote: boolean;
  /** Human-readable summary for system reminder */
  summary: string;
}

export type MemoryPostTurnSyncStatus =
  | "clean"
  | "pushed"
  | "dirty"
  | "conflict"
  | "push_failed"
  | "skipped";

export interface MemoryPostTurnSyncResult {
  status: MemoryPostTurnSyncStatus;
  summary: string;
  memoryDir: string;
  localOnly: boolean;
}

/**
 * Check git status of the memory directory.
 * Used to decide whether to inject a sync reminder.
 */
export async function getMemoryGitStatus(
  agentId: string,
): Promise<MemoryGitStatus> {
  const dir = getScopedMemoryFilesystemRoot(agentId);

  const { stdout: statusOut } = await runGit(dir, ["status", "--porcelain"]);
  const dirty = statusOut.trim().length > 0;

  let aheadOfRemote = false;
  try {
    const { stdout: revListOut } = await runGit(dir, [
      "rev-list",
      "--count",
      "@{u}..HEAD",
    ]);
    aheadOfRemote = (Number.parseInt(revListOut.trim(), 10) || 0) > 0;
  } catch {
    aheadOfRemote = false;
  }

  const parts: string[] = [];
  if (dirty) {
    const changedFiles = statusOut
      .trim()
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => line.trim());
    parts.push(`${changedFiles.length} uncommitted change(s)`);
  }
  if (aheadOfRemote) {
    parts.push("local commits not pushed to remote");
  }

  return {
    dirty,
    aheadOfRemote,
    summary: parts.length > 0 ? parts.join(", ") : "clean",
  };
}

function isUnmergedStatusCode(code: string): boolean {
  return code.includes("U") || code === "AA" || code === "DD";
}

async function getMemoryGitDir(memoryDir: string): Promise<string> {
  const { stdout } = await runGit(memoryDir, ["rev-parse", "--git-dir"]);
  const gitDir = stdout.trim() || ".git";
  return isAbsolute(gitDir) ? gitDir : join(memoryDir, gitDir);
}

async function getMemoryConflictSummary(
  memoryDir: string,
  statusOut?: string,
): Promise<string | null> {
  let operation: string | null = null;
  try {
    const gitDir = await getMemoryGitDir(memoryDir);
    if (existsSync(join(gitDir, "MERGE_HEAD"))) {
      operation = "merge in progress";
    } else if (
      existsSync(join(gitDir, "rebase-merge")) ||
      existsSync(join(gitDir, "rebase-apply"))
    ) {
      operation = "rebase in progress";
    }
  } catch {
    operation = null;
  }

  const status =
    statusOut ?? (await runGit(memoryDir, ["status", "--porcelain"])).stdout;
  const conflictedFiles = status
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line && isUnmergedStatusCode(line.slice(0, 2)))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);

  if (!operation && conflictedFiles.length === 0) {
    return null;
  }

  const parts: string[] = [];
  if (operation) {
    parts.push(operation);
  }
  if (conflictedFiles.length > 0) {
    parts.push(
      `conflicted file(s): ${conflictedFiles.slice(0, 10).join(", ")}${
        conflictedFiles.length > 10
          ? `, and ${conflictedFiles.length - 10} more`
          : ""
      }`,
    );
  }
  return parts.join("; ");
}

async function getMemoryAheadBehind(
  memoryDir: string,
): Promise<{ ahead: number; behind: number } | null> {
  try {
    const { stdout } = await runGit(memoryDir, [
      "rev-list",
      "--left-right",
      "--count",
      "HEAD...@{u}",
    ]);
    const [aheadRaw, behindRaw] = stdout.trim().split(/\s+/);
    return {
      ahead: Number.parseInt(aheadRaw ?? "0", 10) || 0,
      behind: Number.parseInt(behindRaw ?? "0", 10) || 0,
    };
  } catch {
    // No upstream configured or unable to inspect divergence.
    return null;
  }
}

export async function syncPendingMemoryCommitsAfterTurn(
  agentId: string,
  options: { memoryDir?: string } = {},
): Promise<MemoryPostTurnSyncResult> {
  const { getBackend } = await import("@/backend");
  const backend = getBackend();
  const localOnly =
    backend.capabilities.localMemfs && !backend.capabilities.remoteMemfs;
  const memoryDir = options.memoryDir ?? getScopedMemoryFilesystemRoot(agentId);

  if (!existsSync(join(memoryDir, ".git"))) {
    return {
      status: "skipped",
      summary: "Memory repo is not initialized.",
      memoryDir,
      localOnly,
    };
  }

  const { stdout: statusOut } = await runGit(memoryDir, [
    "status",
    "--porcelain",
  ]);
  const conflictSummary = await getMemoryConflictSummary(memoryDir, statusOut);
  if (conflictSummary) {
    return {
      status: "conflict",
      summary: conflictSummary,
      memoryDir,
      localOnly,
    };
  }

  if (statusOut.trim().length > 0) {
    const changedCount = statusOut
      .split("\n")
      .filter((line) => line.trim().length > 0).length;
    return {
      status: "dirty",
      summary: `${changedCount} uncommitted memory change(s).`,
      memoryDir,
      localOnly,
    };
  }

  if (!backend.capabilities.remoteMemfs) {
    return {
      status: "skipped",
      summary: localOnly
        ? "Local backend MemFS has no Letta remote to push."
        : "Active backend does not support remote MemFS pushes.",
      memoryDir,
      localOnly,
    };
  }

  const token = await getAuthToken();
  await prepareMemoryRepoForGitOps(memoryDir, agentId, token);
  const divergence = await getMemoryAheadBehind(memoryDir);
  if (!divergence || divergence.ahead <= 0) {
    return {
      status: "clean",
      summary: "Memory repo is clean and has no pending commits to push.",
      memoryDir,
      localOnly,
    };
  }

  try {
    await runGitWithRetry(memoryDir, ["push", "-u", "origin", "main"], token, {
      operation: "post-turn push pending memory commits",
    });
    return {
      status: "pushed",
      summary: `Pushed ${divergence.ahead} pending memory commit(s).`,
      memoryDir,
      localOnly,
    };
  } catch (pushError) {
    if (!isNonFastForwardPushError(pushError)) {
      return {
        status: "push_failed",
        summary:
          pushError instanceof Error ? pushError.message : String(pushError),
        memoryDir,
        localOnly,
      };
    }

    try {
      await runGitWithRetry(memoryDir, ["pull", "--rebase"], token, {
        operation: "post-turn rebase memory before push",
      });
      const postRebaseConflictSummary =
        await getMemoryConflictSummary(memoryDir);
      if (postRebaseConflictSummary) {
        return {
          status: "conflict",
          summary: postRebaseConflictSummary,
          memoryDir,
          localOnly,
        };
      }
      await runGitWithRetry(
        memoryDir,
        ["push", "-u", "origin", "main"],
        token,
        {
          operation: "post-turn push rebased memory commits",
        },
      );
      return {
        status: "pushed",
        summary: `Rebased and pushed ${divergence.ahead} pending memory commit(s).`,
        memoryDir,
        localOnly,
      };
    } catch (rebaseOrPushError) {
      const postFailureConflictSummary =
        await getMemoryConflictSummary(memoryDir);
      if (postFailureConflictSummary) {
        return {
          status: "conflict",
          summary: postFailureConflictSummary,
          memoryDir,
          localOnly,
        };
      }
      return {
        status: "push_failed",
        summary:
          rebaseOrPushError instanceof Error
            ? rebaseOrPushError.message
            : String(rebaseOrPushError),
        memoryDir,
        localOnly,
      };
    }
  }
}

/**
 * Add the git-memory-enabled tag to an agent.
 * This triggers the backend to create the git repo.
 */
export async function addGitMemoryTag(
  agentId: string,
  prefetchedAgent?: { tags?: string[] | null },
): Promise<void> {
  try {
    const { getBackend } = await import("@/backend");
    const backend = getBackend();
    // Always request tags explicitly: without `include: ["agent.tags"]` the
    // API can omit tags, and writing back an incomplete list would wipe the
    // agent's other tags.
    const agent =
      prefetchedAgent ??
      (await backend.retrieveAgent(agentId, { include: ["agent.tags"] }));
    const tags = agent.tags || [];
    if (!tags.includes(GIT_MEMORY_ENABLED_TAG)) {
      await backend.updateAgent(agentId, {
        tags: [...tags, GIT_MEMORY_ENABLED_TAG],
      });
      debugLog("memfs-git", `Added ${GIT_MEMORY_ENABLED_TAG} tag`);
    }
  } catch (err) {
    debugWarn(
      "memfs-git",
      `Failed to add git-memory tag: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
