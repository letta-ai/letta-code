import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { invalidPendingMemory } from "@/agent/memory-constraints-audit";
import { getMemoryGitDir } from "@/agent/memory-git-dir";
import { execGit } from "@/agent/memory-git-process";
import { getDesktopAccessToken } from "@/auth/desktop-credentials";
import {
  getMemfsGitProxyRewriteConfig,
  getMemfsServerUrl,
} from "@/backend/api/memfs-git-proxy";
import {
  retainCheckouts,
  startCheckout,
  trackCheckoutDiscovery,
} from "@/utils/checkout-readiness";
import { debugLog, debugWarn } from "@/utils/debug";
import { withRepositoryCheckout } from "@/utils/repository-checkout";
import { resolveGlobalConfigDir } from "@/utils/settings-path";
import { GIT_MEMORY_ENABLED_TAG } from "./agent-tags";
import { listAttachedAgentRepositories } from "./attached-repositories";
import {
  type RepositoryMountGitArgs,
  syncAttachedRepositoryCheckout,
} from "./attached-repository-checkout";
import { getAuthToken } from "./memory-auth";
import { getScopedMemoryFilesystemRoot } from "./memory-filesystem";
import { withSerializedGitConfigMutation } from "./memory-git-config-lock";
import {
  installLocalMemoryPreCommitHook,
  installMemoryGitHooks,
  installPostCommitHook,
  installSharedMemoryPreCommitHook,
} from "./memory-git-hooks";
import { GIT_DISABLE_COMMIT_SIGNING_ARGS } from "./memory-git-signing";
import { writeWindowsCredentialHelper } from "./memory-git-windows-credentials";
import { resolveEffectiveAgentId } from "./subagents/ephemeral-subagent";

const RETRYABLE_GIT_HTTP_ERROR_RE =
  /(?:\bHTTP\s+(?:503|520|521|522|523|524)\b|The requested URL returned error:\s*(?:503|520|521|522|523|524))/i;
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
export function getAgentRootDir(agentId: string): string {
  return join(resolveGlobalConfigDir(), "agents", agentId);
}

export function getMemoryRepoDir(agentId: string): string {
  return join(getAgentRootDir(agentId), "memory");
}

function getMemoryRepositoryRepoDir(agentId: string): string {
  return getScopedMemoryFilesystemRoot(agentId);
}

export function normalizeCredentialBaseUrl(serverUrl: string): string {
  const trimmed = serverUrl.trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(trimmed);
    return parsed.origin;
  } catch {
    return trimmed;
  }
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

export function isRepairableMemfsRemoteUrl(
  remoteUrl: string,
  agentId: string,
): boolean {
  const normalized = normalizeRemoteUrl(remoteUrl);
  const escapedAgentId = escapeRegex(agentId);

  if (isMemfsRemoteUrlForAgent(normalized, agentId)) {
    return true;
  }

  if (
    new RegExp(`^https?://[^\\s]+/v1/git/${escapedAgentId}$`, "i").test(
      normalized,
    )
  ) {
    return true;
  }

  return /^https?:\/\/[^\s]+\/v1\/git$/i.test(normalized);
}

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

export function validateAgentRepositoryName(name: string): string {
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

export async function prepareAttachedRepositoryForGitOps(
  args: RepositoryMountGitArgs,
): Promise<void> {
  await maybeUpdateRepositoryRemoteOrigin(args);
  await configureLocalCredentialHelper(
    args.directory,
    args.token,
    args.publishedDirectory,
  );
  await ensureLocalMemfsGitConfig(args.directory, args.agentId);
}

async function syncRepoMount(args: RepositoryMountGitArgs): Promise<void> {
  await syncAttachedRepositoryCheckout(args, {
    git: runGit,
    gitWithRetry: runGitWithRetry,
    prepare: prepareAttachedRepositoryForGitOps,
    installHook: installSharedMemoryPreCommitHook,
    cloneTimeoutMs: GIT_CLONE_TIMEOUT_MS,
  });
}

export async function maybeUpdateMemoryRemoteOrigin(
  repoDir: string,
  agentId: string,
): Promise<void> {
  let currentOrigin = "";
  try {
    const { stdout } = await runGit(repoDir, ["remote", "get-url", "origin"]);
    currentOrigin = stdout.trim();
  } catch {
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
    return;
  }

  if (pushUrls.length === 0) {
    return;
  }

  const pushUrlKey = "remote.origin.pushurl";
  await gitConfig(repoDir, ["config", "--local", "--unset-all", pushUrlKey]);

  debugLog(
    "memfs-git",
    `Cleared origin pushurl for ${agentId}: ${pushUrls.join(", ")}`,
  );
}

function getMemoryRemoteUrl(agentId: string): string {
  return getGitRemoteUrl(agentId);
}

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
  return (
    getDesktopAccessToken() === undefined &&
    getMemfsGitProxyRewriteConfig(env) === null
  );
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

const GIT_DEFAULT_TIMEOUT_MS = 60_000;
const GIT_CLONE_TIMEOUT_MS = 180_000;

export async function runGit(
  cwd: string,
  args: string[],
  token?: string,
  options?: { timeoutMs?: number },
): Promise<{ stdout: string; stderr: string }> {
  const authArgs = token ? buildGitAuthArgs(token) : [];
  const allArgs = [
    ...GIT_DISABLE_COMMIT_SIGNING_ARGS,
    ...buildMemfsGitProxyArgs(args),
    ...authArgs,
    ...args,
  ];

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
  const loggableCommand = redactGitAuthInText(loggableArgs.join(" "));
  debugLog("memfs-git", `git ${loggableCommand} (in ${cwd})`);

  const timeoutMs = options?.timeoutMs ?? GIT_DEFAULT_TIMEOUT_MS;
  let result: Awaited<ReturnType<typeof execGit>>;
  try {
    result = await execGit(allArgs, {
      cwd,
      env: buildNonInteractiveGitEnv(),
      timeoutMs,
    });
  } catch (error) {
    throw redactGitAuthError(error);
  }

  return {
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
  };
}

export function isRetryableGitTransientError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  if (RETRYABLE_GIT_HTTP_ERROR_RE.test(message)) {
    return true;
  }

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

const gitConfig = (dir: string, args: string[]) =>
  withSerializedGitConfigMutation(dir, () => runGit(dir, args));

export async function runGitWithRetry(
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
      if (!existsSync(cwd)) {
        mkdirSync(cwd, { recursive: true });
      }
      return await runGit(cwd, args, token, {
        timeoutMs: options?.timeoutMs,
      });
    } catch (error) {
      if (isMissingCwdGitError(error)) {
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

  throw new Error(`Unexpected retry loop exit for ${operation}`);
}

async function configureLocalCredentialHelper(
  dir: string,
  token: string,
  publishedDirectory = dir,
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
    helper = writeWindowsCredentialHelper(dir, token, publishedDirectory);
    debugLog("memfs-git", `Wrote Windows credential helper script`);
  } else {
    helper = `!f() { echo "username=letta"; echo "password=${token}"; }; f`;
  }

  const writeHelperWithReset = async (key: string) => {
    await gitConfig(dir, ["config", "--local", "--replace-all", key, ""]);
    await gitConfig(dir, ["config", "--local", "--add", key, helper]);
  };
  await writeHelperWithReset(`credential.${normalizedBaseUrl}.helper`);
  if (rawBaseUrl !== normalizedBaseUrl) {
    await writeHelperWithReset(`credential.${rawBaseUrl}.helper`);
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
      await gitConfig(dir, ["config", "--local", "--unset-all", key]);
    } catch {}
  }
}

export async function getLocalGitConfig(
  dir: string,
  key: string,
): Promise<string | null> {
  try {
    const { stdout } = await runGit(dir, ["config", "--local", "--get", key]);
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export async function setLocalGitConfig(
  dir: string,
  key: string,
  value: string,
): Promise<void> {
  await gitConfig(dir, ["config", "--local", "--replace-all", key, value]);
}

async function unsetLocalGitConfig(dir: string, key: string): Promise<void> {
  try {
    await gitConfig(dir, ["config", "--local", "--unset", key]);
  } catch {}
}

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

export async function ensureLocalMemfsGitConfig(
  dir: string,
  agentId: string,
): Promise<void> {
  if (!existsSync(join(dir, ".git"))) {
    return;
  }

  try {
    const currentAgentId = await getLocalGitConfig(dir, "letta.agentId");
    if (currentAgentId !== agentId) {
      await setLocalGitConfig(dir, "letta.agentId", agentId);
    }

    await setLocalGitConfig(dir, "branch.main.remote", "origin");
    await setLocalGitConfig(dir, "branch.main.merge", "refs/heads/main");

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

    const currentGpgSign = await getLocalGitConfig(dir, "commit.gpgsign");
    if (currentGpgSign === null) {
      await setLocalGitConfig(dir, "commit.gpgsign", "false");
    }
  } catch (err) {
    debugWarn(
      "memfs-git",
      `Failed to ensure local memfs git config: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const MEMORY_REPOSITORY_CONFIG_KEY = "letta.memoryRepository.url";
const MEMORY_REPOSITORY_PUSH_LOG = "memory-repository-push.log";

export async function getMemoryRepositoryUrl(
  agentId: string,
): Promise<string | null> {
  const dir = getMemoryRepositoryRepoDir(agentId);
  if (!existsSync(join(dir, ".git"))) {
    return null;
  }
  return await getLocalGitConfig(dir, MEMORY_REPOSITORY_CONFIG_KEY);
}

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

export function isNonFastForwardPushError(error: unknown): boolean {
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
  installMemoryGitHooks(memoryDir);
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
  } catch {}

  await runGit(memoryDir, ["reset", "--hard", "refs/remotes/origin/main"]);
  try {
    await runGit(memoryDir, [
      "branch",
      "--set-upstream-to",
      "origin/main",
      "main",
    ]);
  } catch {}

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
  installLocalMemoryPreCommitHook(memoryDir);
  installPostCommitHook(memoryDir);
  for (const [key, value] of [
    ["letta.agentId", author.agentId],
    ["user.email", author.authorEmail],
    ["user.name", author.authorName.trim() || "Letta Agent"],
  ] as const) {
    if ((await getLocalGitConfig(memoryDir, key)) !== value) {
      await setLocalGitConfig(memoryDir, key, value);
    }
  }
  if ((await getLocalGitConfig(memoryDir, "commit.gpgsign")) === null) {
    await setLocalGitConfig(memoryDir, "commit.gpgsign", "false");
  }
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
  } catch {}
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
  if (await hasMemoryHead(params.memoryDir)) {
    await prepareLocalOnlyMemoryRepoForGitOps(params.memoryDir, author);
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

  await prepareLocalOnlyMemoryRepoForGitOps(params.memoryDir, author);

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

export interface SyncAgentRepositoriesResult {
  mounted: number;
  skipped: number;
  failed: number;
  summaries: string[];
}

function startAttachedAgentRepositories(agentId: string): void {
  void syncAttachedAgentRepositories(agentId).catch((error) => {
    debugWarn(
      "memfs-git",
      `Background repository sync failed: ${String(error)}`,
    );
  });
}

async function syncAttachedRepository(args: {
  agentId: string;
  repositoryName: string;
  token: string;
}): Promise<string> {
  const repositoryName = validateAgentRepositoryName(args.repositoryName);
  const directory = getRepositoryMountDir(args.agentId, repositoryName);
  const remoteUrl = getRepositoryRemoteUrl(args.agentId, repositoryName);
  await startCheckout(
    args.agentId,
    directory,
    () =>
      syncRepoMount({
        agentId: args.agentId,
        repositoryName,
        directory,
        remoteUrl,
        token: args.token,
      }),
    true,
  );
  return `${repositoryName}: ${directory}`;
}

export async function syncAttachedAgentRepositories(
  agentId: string,
): Promise<SyncAgentRepositoriesResult> {
  let repositories: Awaited<ReturnType<typeof listAttachedAgentRepositories>> =
    [];
  let jobs: Promise<string>[] = [];
  try {
    const registered = trackCheckoutDiscovery(agentId, async () => {
      const effectiveAgentId = resolveEffectiveAgentId(agentId);
      repositories = await listAttachedAgentRepositories(effectiveAgentId);
      retainCheckouts(
        agentId,
        repositories.map((repository) =>
          getRepositoryMountDir(
            agentId,
            validateAgentRepositoryName(repository.name),
          ),
        ),
      );
      const token = await getAuthToken();
      jobs = repositories.map((repository) =>
        syncAttachedRepository({
          agentId,
          repositoryName: repository.name,
          token,
        }),
      );
      for (const job of jobs) void job.catch(() => {});
    });
    await registered;
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

  const results = await Promise.allSettled(jobs);

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

export async function cloneMemoryRepo(agentId: string): Promise<void> {
  startAttachedAgentRepositories(agentId);
  const token = await getAuthToken();
  const url = getMemoryRemoteUrl(agentId);
  await withRepositoryCheckout(
    getMemoryRepoDir(agentId),
    async (dir, fresh) => {
      if (fresh) {
        await runGitWithRetry(dir, ["clone", url, "."], token, {
          operation: "clone memory repo",
          timeoutMs: GIT_CLONE_TIMEOUT_MS,
        });
      } else if (!existsSync(join(dir, ".git"))) {
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

          renameSync(join(tmpDir, ".git"), join(dir, ".git"));

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

          debugLog(
            "memfs-git",
            "Migrated existing memory directory to git repo",
          );
        } finally {
          if (existsSync(tmpDir)) {
            rmSync(tmpDir, { recursive: true, force: true });
          }
        }
      }

      await configureLocalCredentialHelper(
        dir,
        token,
        getMemoryRepoDir(agentId),
      );

      installMemoryGitHooks(dir);

      await ensureLocalMemfsGitConfig(dir, agentId);
    },
  );
}

export interface PullMemoryOptions {
  throwOnFailure?: boolean;
}

export async function pullMemory(
  agentId: string,
  options: PullMemoryOptions = {},
): Promise<{ updated: boolean; summary: string }> {
  startAttachedAgentRepositories(agentId);
  const token = await getAuthToken();
  const dir = getMemoryRepoDir(agentId);

  await maybeUpdateMemoryRemoteOrigin(dir, agentId);

  await configureLocalCredentialHelper(dir, token);
  installMemoryGitHooks(dir);
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
    if (!(await hasMergeBaseWithUpstream(dir))) {
      try {
        const summary = await recoverMemoryPullByResettingToRemote(dir, token);
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
      if (isRecoverableMemoryPullHistoryError(rebaseErr)) {
        try {
          const summary = await recoverMemoryPullByResettingToRemote(
            dir,
            token,
          );
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

export async function pushMemory(agentId: string): Promise<void> {
  const token = await getAuthToken();
  const dir = getMemoryRepoDir(agentId);

  await prepareMemoryRepoForGitOps(dir, agentId, token);
  await runGit(dir, ["push", "-u", "origin", "main"], token);
}

export interface MemoryGitStatus {
  dirty: boolean;
  aheadOfRemote: boolean;
  summary: string;
}

export type MemoryPostTurnSyncStatus =
  | "clean"
  | "pushed"
  | "dirty"
  | "conflict"
  | "invalid"
  | "push_failed"
  | "skipped";

export interface MemoryPostTurnSyncResult {
  status: MemoryPostTurnSyncStatus;
  summary: string;
  memoryDir: string;
  localOnly: boolean;
}

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

export async function getMemoryConflictSummary(
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

export async function getMemoryAheadBehind(
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

  const initialValidation = invalidPendingMemory(memoryDir, localOnly);
  if (initialValidation) return initialValidation;

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
      const rebasedValidation = invalidPendingMemory(memoryDir, localOnly);
      if (rebasedValidation) return rebasedValidation;
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

export async function addGitMemoryTag(
  agentId: string,
  prefetchedAgent?: { tags?: string[] | null },
): Promise<void> {
  try {
    const { getBackend } = await import("@/backend");
    const backend = getBackend();
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
