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
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
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

/** Git remote URL for the agent's state repo */
function getGitRemoteUrl(agentId: string): string {
  const baseUrl = getServerUrl();
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
  const baseUrl = getServerUrl();
  const helper = `!f() { echo "username=letta"; echo "password=${token}"; }; f`;
  await runGit(dir, ["config", `credential.${baseUrl}.helper`, helper]);
  debugLog("memfs-git", "Configured local credential helper");
}

/** Check if the agent root directory is a git repo */
export function isGitRepo(agentId: string): boolean {
  return existsSync(join(getAgentRootDir(agentId), ".git"));
}

/**
 * Clone the agent's state repo to the agent root directory.
 *
 * If the directory already exists (e.g., from old memFS), clones
 * to a temp location and moves .git/ into the existing dir, then
 * checks out to get the repo's files.
 */
export async function cloneMemoryRepo(agentId: string): Promise<void> {
  const token = await getAuthToken();
  const url = getGitRemoteUrl(agentId);
  const dir = getAgentRootDir(agentId);

  debugLog("memfs-git", `Cloning ${url} → ${dir}`);

  if (!existsSync(dir)) {
    // Fresh clone into new directory
    mkdirSync(dir, { recursive: true });
    await runGit(dir, ["clone", url, "."], token);
  } else if (!existsSync(join(dir, ".git"))) {
    // Directory exists but isn't a git repo (old memFS).
    // Clone to temp, move .git/ into existing dir.
    const tmpDir = `${dir}-git-clone-tmp`;
    try {
      if (existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
      mkdirSync(tmpDir, { recursive: true });
      await runGit(tmpDir, ["clone", url, "."], token);

      // Move .git into the existing agent directory
      renameSync(join(tmpDir, ".git"), join(dir, ".git"));

      // Reset to match remote state (gets repo files without
      // clobbering untracked local files like settings)
      await runGit(dir, ["checkout", "--", "."], token);

      debugLog("memfs-git", "Migrated existing directory to git repo");
    } finally {
      if (existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  }

  // Configure local credential helper so the agent can do plain
  // `git push` / `git pull` without auth prefixes.
  await configureLocalCredentialHelper(dir, token);
}

/**
 * Pull latest changes from the server.
 * Called on startup to ensure local state is current.
 */
export async function pullMemory(
  agentId: string,
): Promise<{ updated: boolean; summary: string }> {
  const token = await getAuthToken();
  const dir = getAgentRootDir(agentId);

  // Ensure credential helper is configured (self-healing for old clones)
  await configureLocalCredentialHelper(dir, token);

  try {
    const { stdout, stderr } = await runGit(dir, ["pull", "--ff-only"]);
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
      const { stdout, stderr } = await runGit(dir, ["pull", "--rebase"]);
      return { updated: true, summary: (stdout + stderr).trim() };
    } catch (rebaseErr) {
      const msg =
        rebaseErr instanceof Error ? rebaseErr.message : String(rebaseErr);
      debugWarn("memfs-git", `Pull failed: ${msg}`);
      return { updated: false, summary: `Pull failed: ${msg}` };
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
  const dir = getAgentRootDir(agentId);

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
