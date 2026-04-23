/**
 * Git operations for git-backed agent memory.
 *
 * When memFS is enabled, the agent's memory is stored in a git repo
 * on the server at $LETTA_BASE_URL/v1/git/$AGENT_ID/state.git.
 * This module provides the CLI harness helpers: clone on first run,
 * pull on startup, and status check for system reminders.
 *
 * The agent itself handles commit/push via Bash tool calls.
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
import { join } from "node:path";
import { promisify } from "node:util";
import { debugLog, debugWarn } from "../utils/debug";
import { getClient, getServerUrl } from "./client";

const execFile = promisify(execFileCb);

export const GIT_MEMORY_ENABLED_TAG = "git-memory-enabled";

const RETRYABLE_GIT_HTTP_ERROR_RE =
  /(?:\bHTTP\s+(?:520|521|522|523|524)\b|The requested URL returned error:\s*(?:520|521|522|523|524))/i;
const RETRYABLE_GIT_NETWORK_ERROR_RE =
  /(remote end hung up unexpectedly|connection reset by peer|operation timed out|timed out)/i;

const MISSING_CWD_GIT_ERROR_RE =
  /(Unable to read current working directory: No such file or directory|\buv_cwd\b|\bcwd\b.*\bENOENT\b)/i;

const NON_FAST_FORWARD_PUSH_ERROR_RE =
  /(non-fast-forward|fetch first|failed to push some refs|updates were rejected|remote contains work that you do not have locally|tip of your current branch is behind)/i;

const AGENT_DISPLAY_NAME_TIMEOUT_MS = 3_000;

export interface MemoryCommitAuthor {
  agentId: string;
  authorName: string;
  authorEmail: string;
}

export interface CommitAndSyncMemoryWriteParams {
  memoryDir: string;
  pathspecs: string[];
  reason: string;
  author: MemoryCommitAuthor;
  replay?: () => Promise<string[]>;
}

export interface CommitAndSyncMemoryWriteResult {
  committed: boolean;
  sha?: string;
  replayed?: boolean;
  replayNoop?: boolean;
  rescueRef?: string;
}

/** Get the agent root directory (~/.letta/agents/{id}/) */
export function getAgentRootDir(agentId: string): string {
  return join(homedir(), ".letta", "agents", agentId);
}

/** Get the git repo directory for memory (now ~/.letta/agents/{id}/memory/) */
export function getMemoryRepoDir(agentId: string): string {
  return join(getAgentRootDir(agentId), "memory");
}

/**
 * Normalize a configured server URL for use in git credential config keys.
 *
 * Git credential config lookup is sensitive to URL key shape. We normalize to
 * origin form (scheme + host + optional port) and remove trailing slashes so
 * pull/push flows remain resilient when LETTA_BASE_URL has path/trailing-slash
 * variations.
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

/** Git remote URL for the agent's state repo */
export function getGitRemoteUrl(agentId: string, baseUrl?: string): string {
  const resolvedBaseUrl = (baseUrl ?? getServerUrl())
    .trim()
    .replace(/\/+$/, "");
  return `${resolvedBaseUrl}/v1/git/${agentId}/state.git`;
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
    // No origin remote configured — leave as-is.
    return;
  }

  if (!currentOrigin) {
    return;
  }

  if (!isMemfsRemoteUrlForAgent(currentOrigin, agentId)) {
    return;
  }

  const expectedOrigin = normalizeRemoteUrl(getGitRemoteUrl(agentId));
  const normalizedCurrent = normalizeRemoteUrl(currentOrigin);

  if (normalizedCurrent === expectedOrigin) {
    return;
  }

  await runGit(repoDir, ["remote", "set-url", "origin", expectedOrigin]);

  debugLog(
    "memfs-git",
    `Updated origin remote for ${agentId}: ${normalizedCurrent} -> ${expectedOrigin}`,
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
  const client = await getClient();
  // The client constructor resolves the token; extract it
  // biome-ignore lint/suspicious/noExplicitAny: accessing internal client options
  return (client as any)._options?.apiKey ?? "";
}

/**
 * Run a git command in the given directory.
 * If a token is provided, passes it as an auth header.
 */
async function runGit(
  cwd: string,
  args: string[],
  token?: string,
): Promise<{ stdout: string; stderr: string }> {
  const authArgs = token
    ? [
        "-c",
        `http.extraHeader=Authorization: Basic ${Buffer.from(`letta:${token}`).toString("base64")}`,
      ]
    : [];
  const allArgs = [...authArgs, ...args];

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

  const result = await execFile("git", allArgs, {
    cwd,
    maxBuffer: 10 * 1024 * 1024, // 10MB
    timeout: 60_000, // 60s
  });

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
  options?: { operation?: string; attempts?: number; baseDelayMs?: number },
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
      return await runGit(cwd, args, token);
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
      const msg = error instanceof Error ? error.message : String(error);
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
 *
 * On Windows, we write a batch script because the bash-style inline
 * helper (`!f() { ... }; f`) doesn't work in PowerShell/cmd.
 */
async function configureLocalCredentialHelper(
  dir: string,
  token: string,
): Promise<void> {
  const rawBaseUrl = getServerUrl();
  const normalizedBaseUrl = normalizeCredentialBaseUrl(rawBaseUrl);

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
    const client = await getClient();
    const agent = await Promise.race([
      client.agents.retrieve(agentId),
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
  const dir = getMemoryRepoDir(agentId);
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
  const dir = getMemoryRepoDir(agentId);
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
  const dir = getMemoryRepoDir(agentId);
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
  const dir = getMemoryRepoDir(agentId);
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
    getMemoryRepoDir(agentId),
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

async function fetchMemoryRemote(
  memoryDir: string,
  token: string,
): Promise<void> {
  await runGitWithRetry(memoryDir, ["fetch", "origin"], token, {
    operation: "fetch origin",
  });
}

async function resetMemoryToUpstream(
  memoryDir: string,
  token: string,
): Promise<void> {
  await runGit(memoryDir, ["reset", "--hard", "@{u}"], token);
}

function buildMemoryConflictRef(sha: string): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  return `refs/letta-conflicts/${timestamp}-${sha.slice(0, 7)}`;
}

async function preserveMemoryCommit(
  memoryDir: string,
  sha: string,
): Promise<string> {
  const ref = buildMemoryConflictRef(sha);
  await runGit(memoryDir, ["update-ref", ref, sha]);
  return ref;
}

function formatCommittedButPushFailed(sha: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Memory changes were committed (${sha.slice(0, 7)}) but push failed: ${message}`;
}

function formatReplayConflict(
  sha: string,
  rescueRef: string,
  error: unknown,
): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Memory changes conflicted with newer remote memory and could not be replayed safely. Preserved local commit ${sha.slice(0, 7)} at ${rescueRef}; local branch was reset to upstream. Replay error: ${message}`;
}

function formatReplayPushFailure(
  originalSha: string,
  originalRef: string,
  replaySha: string | undefined,
  replayRef: string | undefined,
  error: unknown,
): string {
  const message = error instanceof Error ? error.message : String(error);
  const replaySummary =
    replaySha && replayRef
      ? ` Replayed commit ${replaySha.slice(0, 7)} was preserved at ${replayRef}.`
      : "";
  return `Memory changes conflicted with newer remote memory and the replayed update could not be pushed safely. Original commit ${originalSha.slice(0, 7)} was preserved at ${originalRef}.${replaySummary} Local branch was reset to upstream. Push error: ${message}`;
}

async function recoverMemoryPushConflict(
  params: CommitAndSyncMemoryWriteParams,
  token: string,
  initialSha: string,
): Promise<CommitAndSyncMemoryWriteResult> {
  const rescueRef = await preserveMemoryCommit(params.memoryDir, initialSha);

  await fetchMemoryRemote(params.memoryDir, token);
  await resetMemoryToUpstream(params.memoryDir, token);

  let replayedPathspecs: string[] = [];
  try {
    replayedPathspecs = normalizePathspecs((await params.replay?.()) ?? []);
  } catch (error) {
    await resetMemoryToUpstream(params.memoryDir, token);
    throw new Error(formatReplayConflict(initialSha, rescueRef, error));
  }

  let replayCommit: { committed: boolean; sha?: string };
  try {
    replayCommit = await commitMemoryPaths(
      params.memoryDir,
      replayedPathspecs,
      params.reason,
      params.author,
    );
  } catch (error) {
    await resetMemoryToUpstream(params.memoryDir, token);
    throw new Error(formatReplayConflict(initialSha, rescueRef, error));
  }

  if (!replayCommit.committed) {
    return {
      committed: true,
      replayed: true,
      replayNoop: true,
      rescueRef,
    };
  }

  try {
    await runGit(params.memoryDir, ["push"], token);
  } catch (error) {
    const replayRef = replayCommit.sha
      ? await preserveMemoryCommit(params.memoryDir, replayCommit.sha)
      : undefined;
    await resetMemoryToUpstream(params.memoryDir, token);
    throw new Error(
      formatReplayPushFailure(
        initialSha,
        rescueRef,
        replayCommit.sha,
        replayRef,
        error,
      ),
    );
  }

  return {
    committed: true,
    sha: replayCommit.sha,
    replayed: true,
    rescueRef,
  };
}

export async function assertMemoryRepoReadyForWrite(
  memoryDir: string,
): Promise<void> {
  const status = await runGit(memoryDir, ["status", "--porcelain"]);
  if (status.stdout.trim().length > 0) {
    throw new Error(
      "Memory repo has uncommitted changes. Commit, discard, or sync them before using memory tools.",
    );
  }

  try {
    const { stdout } = await runGit(memoryDir, [
      "rev-list",
      "--count",
      "@{u}..HEAD",
    ]);
    const aheadCount = parseInt(stdout.trim(), 10);
    if (aheadCount > 0) {
      throw new Error(
        "Memory repo has local commits that are not pushed to remote. Sync the repo before using memory tools.",
      );
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("not pushed to remote")
    ) {
      throw error;
    }
  }
}

export async function commitAndSyncMemoryWrite(
  params: CommitAndSyncMemoryWriteParams,
): Promise<CommitAndSyncMemoryWriteResult> {
  const normalizedPathspecs = normalizePathspecs(params.pathspecs);
  if (normalizedPathspecs.length === 0) {
    return { committed: false };
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

  try {
    await runGit(params.memoryDir, ["push"], token);
  } catch (error) {
    if (!params.replay || !isNonFastForwardPushError(error)) {
      throw new Error(formatCommittedButPushFailed(commitResult.sha, error));
    }
    return recoverMemoryPushConflict(params, token, commitResult.sha);
  }

  return {
    committed: true,
    sha: commitResult.sha,
  };
}

/** Check if the memory directory is a git repo */
export function isGitRepo(agentId: string): boolean {
  return existsSync(join(getMemoryRepoDir(agentId), ".git"));
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
      });

      // Move .git into the existing memory directory
      renameSync(join(tmpDir, ".git"), join(dir, ".git"));

      // Reset to match remote state
      await runGit(dir, ["checkout", "--", "."], token);

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
}

/**
 * Pull latest changes from the server.
 * Called on startup to ensure local state is current.
 */
export async function pullMemory(
  agentId: string,
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
    return {
      updated,
      summary: updated ? output.trim() : "Already up to date",
    };
  } catch {
    // If ff-only fails (diverged), try rebase
    debugWarn("memfs-git", "Fast-forward pull failed, trying rebase");
    try {
      const { stdout, stderr } = await runGitWithRetry(
        dir,
        ["pull", "--rebase"],
        token,
        { operation: "pull --rebase" },
      );
      return { updated: true, summary: (stdout + stderr).trim() };
    } catch (rebaseErr) {
      const msg =
        rebaseErr instanceof Error ? rebaseErr.message : String(rebaseErr);
      debugWarn("memfs-git", `Pull failed: ${msg}`);
      return {
        updated: false,
        summary: `Pull failed: ${msg}\nHint: verify remote and auth:\n- git -C ${dir} remote -v\n- git -C ${dir} config --get-regexp '^credential\\..*\\.helper$'`,
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
  await runGit(dir, ["push"], token);
}

export interface MemoryGitStatus {
  /** Uncommitted changes in working tree */
  dirty: boolean;
  /** Local commits not pushed to remote */
  aheadOfRemote: boolean;
  /** Human-readable summary for system reminder */
  summary: string;
}

/**
 * Check git status of the memory directory.
 * Used to decide whether to inject a sync reminder.
 */
export async function getMemoryGitStatus(
  agentId: string,
): Promise<MemoryGitStatus> {
  const dir = getMemoryRepoDir(agentId);

  // Check for uncommitted changes
  const { stdout: statusOut } = await runGit(dir, ["status", "--porcelain"]);
  const dirty = statusOut.trim().length > 0;

  // Check if local is ahead of remote
  let aheadOfRemote = false;
  try {
    const { stdout: revListOut } = await runGit(dir, [
      "rev-list",
      "--count",
      "@{u}..HEAD",
    ]);
    const aheadCount = parseInt(revListOut.trim(), 10);
    aheadOfRemote = aheadCount > 0;
  } catch {
    // No upstream configured or other error - ignore
  }

  // Build summary
  const parts: string[] = [];
  if (dirty) {
    const changedFiles = statusOut
      .trim()
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => l.trim());
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

/**
 * Add the git-memory-enabled tag to an agent.
 * This triggers the backend to create the git repo.
 */
export async function addGitMemoryTag(
  agentId: string,
  prefetchedAgent?: { tags?: string[] | null },
): Promise<void> {
  const client = await getClient();
  try {
    const agent = prefetchedAgent ?? (await client.agents.retrieve(agentId));
    const tags = agent.tags || [];
    if (!tags.includes(GIT_MEMORY_ENABLED_TAG)) {
      await client.agents.update(agentId, {
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

/**
 * Remove the git-memory-enabled tag from an agent.
 */
export async function removeGitMemoryTag(agentId: string): Promise<void> {
  const client = await getClient();
  try {
    const agent = await client.agents.retrieve(agentId);
    const tags = agent.tags || [];
    if (tags.includes(GIT_MEMORY_ENABLED_TAG)) {
      await client.agents.update(agentId, {
        tags: tags.filter((t) => t !== GIT_MEMORY_ENABLED_TAG),
      });
      debugLog("memfs-git", `Removed ${GIT_MEMORY_ENABLED_TAG} tag`);
    }
  } catch (err) {
    debugWarn(
      "memfs-git",
      `Failed to remove git-memory tag: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
