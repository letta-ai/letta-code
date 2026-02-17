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
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { debugLog, debugWarn } from "../utils/debug";
import { getClient, getServerUrl } from "./client";

const execFile = promisify(execFileCb);

const GIT_MEMORY_ENABLED_TAG = "git-memory-enabled";

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

/** Git remote URL for the agent's state repo */
function getGitRemoteUrl(agentId: string): string {
  const baseUrl = getServerUrl().trim().replace(/\/+$/, "");
  return `${baseUrl}/v1/git/${agentId}/state.git`;
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

  debugLog("memfs-git", `git ${args.join(" ")} (in ${cwd})`);

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
 * Configure a local credential helper in the repo's .git/config
 * so plain `git push` / `git pull` work without auth prefixes.
 */
async function configureLocalCredentialHelper(
  dir: string,
  token: string,
): Promise<void> {
  const rawBaseUrl = getServerUrl();
  const normalizedBaseUrl = normalizeCredentialBaseUrl(rawBaseUrl);
  const helper = `!f() { echo "username=letta"; echo "password=${token}"; }; f`;

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
 * - Required fields: description (non-empty string), limit (positive integer)
 * - read_only is a PROTECTED field: agent cannot add, remove, or change it.
 *   Files where HEAD has read_only: true cannot be modified at all.
 * - Only allowed agent-editable keys: description, limit
 * - read_only may exist (from server) but agent must not change it
 */
export const PRE_COMMIT_HOOK_SCRIPT = `#!/usr/bin/env bash
# Validate frontmatter in staged memory .md files
# Installed by Letta Code CLI

AGENT_EDITABLE_KEYS="description limit"
PROTECTED_KEYS="read_only"
ALL_KNOWN_KEYS="description limit read_only"
errors=""

# Helper: extract a frontmatter value from content
get_fm_value() {
  local content="$1" key="$2"
  local closing_line
  closing_line=$(echo "$content" | tail -n +2 | grep -n '^---$' | head -1 | cut -d: -f1)
  [ -z "$closing_line" ] && return
  echo "$content" | tail -n +2 | head -n $((closing_line - 1)) | grep "^$key:" | cut -d: -f2- | sed 's/^ *//;s/ *$//'
}

for file in $(git diff --cached --name-only --diff-filter=ACM | grep '^memory/.*\\.md$'); do
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
  has_limit=false

  # Validate each line
  while IFS= read -r line; do
    [ -z "$line" ] && continue

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
        has_limit=true
        if ! echo "$value" | grep -qE '^[0-9]+$' || [ "$value" = "0" ]; then
          errors="$errors\\n  $file: 'limit' must be a positive integer, got '$value'"
        fi
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
  if [ "$has_limit" = "false" ]; then
    errors="$errors\\n  $file: missing required field 'limit'"
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
  const url = getGitRemoteUrl(agentId);
  const dir = getMemoryRepoDir(agentId);

  debugLog("memfs-git", `Cloning ${url} → ${dir}`);

  if (!existsSync(dir)) {
    // Fresh clone into new memory directory
    mkdirSync(dir, { recursive: true });
    await runGit(dir, ["clone", url, "."], token);
  } else if (!existsSync(join(dir, ".git"))) {
    // Directory exists but isn't a git repo (legacy local layout)
    // Clone to temp, move .git/ into existing dir, then checkout files.
    const tmpDir = `${dir}-git-clone-tmp`;
    try {
      if (existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
      mkdirSync(tmpDir, { recursive: true });
      await runGit(tmpDir, ["clone", url, "."], token);

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

  // Install pre-commit hook to validate frontmatter
  installPreCommitHook(dir);
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

  // Self-healing: ensure credential helper and pre-commit hook are configured
  await configureLocalCredentialHelper(dir, token);
  installPreCommitHook(dir);

  try {
    const { stdout, stderr } = await runGit(dir, ["pull", "--ff-only"], token);
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
      const { stdout, stderr } = await runGit(dir, ["pull", "--rebase"], token);
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
export async function addGitMemoryTag(agentId: string): Promise<void> {
  const client = await getClient();
  try {
    const agent = await client.agents.retrieve(agentId);
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
