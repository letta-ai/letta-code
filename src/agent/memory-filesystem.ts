import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { CreateBlock } from "@letta-ai/letta-client/resources/blocks/blocks";
import type { Backend } from "@/backend";
import {
  getLocalBackendMemoryFilesystemRoot,
  getLocalBackendStorageDir,
  isLocalBackendEnvEnabled,
} from "@/backend/local/paths";
import { debugLog } from "@/utils/debug";
import {
  DIRECTORY_LIMIT_DEFAULTS,
  getDirectoryLimits,
} from "@/utils/directory-limits";
import {
  hasGlobalConfigDirOverride,
  resolveGlobalConfigDir,
} from "@/utils/settings-path";
import { getCurrentAgentId } from "./context";
import { DEFAULT_ROOT_MEMORY_BLOCK } from "./create-agent-request";
import { installMemoryGitHooks } from "./memory-git-hooks";

export const MEMORY_FS_ROOT = ".letta";
export const MEMORY_FS_AGENTS_DIR = "agents";
export const MEMORY_FS_MEMORY_DIR = "memory";
export const MEMORY_SYSTEM_DIR = "system";
export const MEMORY_TREE_MAX_LINES = DIRECTORY_LIMIT_DEFAULTS.memfsTreeMaxLines;
export const MEMORY_TREE_MAX_CHARS = DIRECTORY_LIMIT_DEFAULTS.memfsTreeMaxChars;
export const MEMORY_TREE_MAX_CHILDREN_PER_DIR =
  DIRECTORY_LIMIT_DEFAULTS.memfsTreeMaxChildrenPerDir;

export interface MemoryTreeRenderOptions {
  maxLines?: number;
  maxChars?: number;
  maxChildrenPerDir?: number;
}

export function getMemoryFilesystemRoot(
  agentId: string,
  homeDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configDir =
    homeDir === undefined || hasGlobalConfigDirOverride(env)
      ? resolveGlobalConfigDir(env, homeDir)
      : join(homeDir, MEMORY_FS_ROOT);
  return join(configDir, MEMORY_FS_AGENTS_DIR, agentId, MEMORY_FS_MEMORY_DIR);
}

export function getMemorySystemDir(
  agentId: string,
  homeDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(
    getMemoryFilesystemRoot(agentId, homeDir, env),
    MEMORY_SYSTEM_DIR,
  );
}

export function getScopedMemoryFilesystemRoot(
  agentId: string,
  options: {
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    localBackendStorageDir?: string;
  } = {},
): string {
  const env = options.env ?? process.env;
  if (isLocalBackendEnvEnabled(env)) {
    const storageDir =
      options.localBackendStorageDir ??
      env.LETTA_LOCAL_BACKEND_DIR ??
      getLocalBackendStorageDir(options.homeDir, env);
    return getLocalBackendMemoryFilesystemRoot(agentId, storageDir);
  }
  return getMemoryFilesystemRoot(agentId, options.homeDir, env);
}

export interface ResolveScopedMemoryDirOptions {
  agentId?: string | null;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export function resolveScopedMemoryDir(
  options: ResolveScopedMemoryDirOptions = {},
): string | null {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? env.HOME ?? env.USERPROFILE ?? homedir();

  const explicitAgentId = options.agentId?.trim();
  if (explicitAgentId) {
    return getScopedMemoryFilesystemRoot(explicitAgentId, { env, homeDir });
  }

  try {
    const scopedAgentId = getCurrentAgentId().trim();
    if (scopedAgentId) {
      return getScopedMemoryFilesystemRoot(scopedAgentId, { env, homeDir });
    }
  } catch {}

  const directMemoryDir = (env.LETTA_MEMORY_DIR || env.MEMORY_DIR || "").trim();
  if (directMemoryDir) {
    return resolve(directMemoryDir);
  }

  const envAgentId = (env.LETTA_AGENT_ID || env.AGENT_ID || "").trim();
  if (envAgentId) {
    return getScopedMemoryFilesystemRoot(envAgentId, { env, homeDir });
  }

  return null;
}

export function ensureMemoryFilesystemDirs(
  agentId: string,
  homeDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const root = getMemoryFilesystemRoot(agentId, homeDir, env);
  const systemDir = getMemorySystemDir(agentId, homeDir, env);

  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
  }
  if (!existsSync(systemDir)) {
    mkdirSync(systemDir, { recursive: true });
  }
}

export interface MemfsCreateBodyLike {
  tags?: string[] | null;
  memory_blocks?: CreateBlock[] | null;
}

export function stampMemfsTagOnCreateBody<T extends MemfsCreateBodyLike>(
  body: T,
  gitMemoryEnabledTag: string,
): T {
  const tags = Array.isArray(body.tags) ? body.tags : [];
  if (tags.includes(gitMemoryEnabledTag)) return body;
  return { ...body, tags: [...tags, gitMemoryEnabledTag] };
}

export function stampRootMemoryOnCreateBody<T extends MemfsCreateBodyLike>(
  body: T,
): T {
  const blocks = Array.isArray(body.memory_blocks) ? body.memory_blocks : [];
  if (blocks.some((block) => block.label === DEFAULT_ROOT_MEMORY_BLOCK.label)) {
    return body;
  }
  return {
    ...body,
    memory_blocks: [{ ...DEFAULT_ROOT_MEMORY_BLOCK }, ...blocks],
  };
}

export async function prepareRawCreateAgentBodyForMemfs<
  T extends MemfsCreateBodyLike,
>(body: T): Promise<T> {
  const { getBackend } = await import("@/backend");
  const backend = getBackend();
  if (backend.capabilities.localMemfs) return body;
  if (!backend.capabilities.remoteMemfs) return body;
  if (!(await isLettaCloud())) return body;

  const { GIT_MEMORY_ENABLED_TAG } = await import("@/agent/agent-tags");
  return stampRootMemoryOnCreateBody(
    stampMemfsTagOnCreateBody(body, GIT_MEMORY_ENABLED_TAG),
  );
}

export async function hydrateMemfsSettingFromAgent(
  agent: Pick<AgentState, "id" | "tags">,
): Promise<boolean> {
  const { GIT_MEMORY_ENABLED_TAG } = await import("@/agent/agent-tags");
  const enabled = agent.tags?.includes(GIT_MEMORY_ENABLED_TAG) ?? false;

  const { settingsManager } = await import("@/settings-manager");
  settingsManager.setMemfsEnabled(agent.id, enabled);
  return enabled;
}

export async function isMemfsEnabledOnServer(
  agentId: string,
): Promise<boolean> {
  const { getBackend } = await import("@/backend");
  const backend = getBackend();

  if (backend.capabilities.localMemfs) {
    const { isLocalBackendMemfsDisabledForProcess } = await import(
      "@/backend/local/paths"
    );
    const enabled = !isLocalBackendMemfsDisabledForProcess();
    const { settingsManager } = await import("@/settings-manager");
    settingsManager.setMemfsEnabled(agentId, enabled);
    return enabled;
  }

  const agent = await backend.retrieveAgent(agentId, {
    include: ["agent.tags"],
  });
  const { GIT_MEMORY_ENABLED_TAG } = await import("@/agent/agent-tags");
  const enabled = agent.tags?.includes(GIT_MEMORY_ENABLED_TAG) ?? false;

  const { settingsManager } = await import("@/settings-manager");
  settingsManager.setMemfsEnabled(agentId, enabled);
  return enabled;
}

export interface EnsureLocalMemfsCheckoutOptions {
  pullOnExistingRepo?: boolean;
}

export async function ensureLocalMemfsCheckout(
  agentId: string,
  options: EnsureLocalMemfsCheckoutOptions = {},
): Promise<void> {
  if (isLocalBackendEnvEnabled()) {
    const { initializeLocalMemoryRepo } = await import("@/agent/memory-git");
    await initializeLocalMemoryRepo({
      memoryDir: getScopedMemoryFilesystemRoot(agentId),
      agentId,
      files: [],
    });
    return;
  }

  const { isGitRepo, cloneMemoryRepo, pullMemory } = await import(
    "@/agent/memory-git"
  );
  if (isGitRepo(agentId)) {
    if (options.pullOnExistingRepo) {
      await pullMemory(agentId, { throwOnFailure: true });
    } else {
      installMemoryGitHooks(getScopedMemoryFilesystemRoot(agentId));
    }
    return;
  }
  await cloneMemoryRepo(agentId);
}

export function labelFromRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  return normalized.replace(/\.md$/, "");
}

export function renderMemoryFilesystemTree(
  systemLabels: string[],
  detachedLabels: string[],
  options: MemoryTreeRenderOptions = {},
): string {
  type TreeNode = { children: Map<string, TreeNode>; isFile: boolean };

  const makeNode = (): TreeNode => ({ children: new Map(), isFile: false });
  const root = makeNode();

  const insertPath = (base: string | null, label: string) => {
    const parts = base ? [base, ...label.split("/")] : label.split("/");
    let current = root;
    for (const [i, partName] of parts.entries()) {
      const part = i === parts.length - 1 ? `${partName}.md` : partName;
      if (!current.children.has(part)) {
        current.children.set(part, makeNode());
      }
      current = current.children.get(part) as TreeNode;
      if (i === parts.length - 1) {
        current.isFile = true;
      }
    }
  };

  for (const label of systemLabels) {
    insertPath(MEMORY_SYSTEM_DIR, label);
  }
  for (const label of detachedLabels) {
    insertPath(null, label);
  }

  if (!root.children.has(MEMORY_SYSTEM_DIR)) {
    root.children.set(MEMORY_SYSTEM_DIR, makeNode());
  }

  const sortedEntries = (node: TreeNode) => {
    const entries = Array.from(node.children.entries());
    return entries.sort(([nameA, nodeA], [nameB, nodeB]) => {
      if (nodeA.isFile !== nodeB.isFile) {
        return nodeA.isFile ? 1 : -1;
      }
      return nameA.localeCompare(nameB);
    });
  };

  const limits = getDirectoryLimits();
  const maxLines = Math.max(2, options.maxLines ?? limits.memfsTreeMaxLines);
  const maxChars = Math.max(128, options.maxChars ?? limits.memfsTreeMaxChars);
  const maxChildrenPerDir = Math.max(
    1,
    options.maxChildrenPerDir ?? limits.memfsTreeMaxChildrenPerDir,
  );

  const rootLine = "/memory/";
  const lines: string[] = [rootLine];
  let totalChars = rootLine.length;

  const countTreeEntries = (node: TreeNode): number => {
    let total = 0;
    for (const [, child] of node.children) {
      total += 1;
      if (child.children.size > 0) {
        total += countTreeEntries(child);
      }
    }
    return total;
  };

  const canAppendLine = (line: string): boolean => {
    const nextLineCount = lines.length + 1;
    const nextCharCount = totalChars + 1 + line.length;
    return nextLineCount <= maxLines && nextCharCount <= maxChars;
  };

  const render = (node: TreeNode, prefix: string): boolean => {
    const entries = sortedEntries(node);
    const visibleEntries = entries.slice(0, maxChildrenPerDir);
    const omittedEntries = Math.max(0, entries.length - visibleEntries.length);

    const renderItems: Array<
      | { kind: "entry"; name: string; child: TreeNode }
      | { kind: "omitted"; omittedCount: number }
    > = visibleEntries.map(([name, child]) => ({
      kind: "entry",
      name,
      child,
    }));

    if (omittedEntries > 0) {
      renderItems.push({ kind: "omitted", omittedCount: omittedEntries });
    }

    for (const [index, item] of renderItems.entries()) {
      const isLast = index === renderItems.length - 1;
      const branch = isLast ? "└──" : "├──";
      const line =
        item.kind === "entry"
          ? `${prefix}${branch} ${item.name}${item.child.isFile ? "" : "/"}`
          : `${prefix}${branch} … (${item.omittedCount.toLocaleString()} more entries)`;

      if (!canAppendLine(line)) {
        return false;
      }

      lines.push(line);
      totalChars += 1 + line.length;

      if (item.kind === "entry" && item.child.children.size > 0) {
        const nextPrefix = `${prefix}${isLast ? "    " : "│   "}`;
        if (!render(item.child, nextPrefix)) {
          return false;
        }
      }
    }

    return true;
  };

  const totalEntries = countTreeEntries(root);
  const fullyRendered = render(root, "");

  if (!fullyRendered) {
    while (lines.length > 1) {
      const shownEntries = Math.max(0, lines.length - 1);
      const omittedEntries = Math.max(1, totalEntries - shownEntries);
      const notice = `[Tree truncated: showing ${shownEntries.toLocaleString()} of ${totalEntries.toLocaleString()} entries. ${omittedEntries.toLocaleString()} omitted.]`;

      if (canAppendLine(notice)) {
        lines.push(notice);
        break;
      }

      const removed = lines.pop();
      if (removed) {
        totalChars -= 1 + removed.length;
      }
    }
  }

  return lines.join("\n");
}

export interface ApplyMemfsFlagsResult {
  action: "enabled" | "unchanged";
  memoryDir?: string;
  pullSummary?: string;
}

export interface ApplyMemfsFlagsOptions {
  throwOnPullFailure?: boolean;
  pullOnExistingRepo?: boolean;
  agentTags?: string[];
  skipPromptUpdate?: boolean;
}

async function seedDefaultPersonalityFiles(
  agentId: string,
  memoryDir: string,
  syncMode: "local" | "remote",
  agentTags?: readonly string[] | null,
): Promise<void> {
  const { seedPersonalityDefaultMemoryFilesBestEffort } = await import(
    "@/agent/personality-default-files"
  );
  await seedPersonalityDefaultMemoryFilesBestEffort({
    agentId,
    memoryDir,
    agentTags,
    syncMode,
  });
}

export async function applyMemfsFlags(
  agentId: string,
  memfsFlag: boolean | undefined,
  options?: ApplyMemfsFlagsOptions,
): Promise<ApplyMemfsFlagsResult> {
  const { settingsManager } = await import("@/settings-manager");
  const { getBackend } = await import("@/backend");
  const backend = getBackend();

  const { GIT_MEMORY_ENABLED_TAG, isStatelessSubagentTags } = await import(
    "@/agent/agent-tags"
  );
  const tags =
    options?.agentTags ??
    (await backend.retrieveAgent(agentId, { include: ["agent.tags"] })).tags;
  if (isStatelessSubagentTags(tags)) {
    debugLog("memfs", `Not enabling MemFS for stateless subagent ${agentId}`);
    return { action: "unchanged" };
  }

  if (backend.capabilities.localMemfs) {
    const memoryDir = getScopedMemoryFilesystemRoot(agentId);
    const { initializeLocalMemoryRepo } = await import("@/agent/memory-git");
    await initializeLocalMemoryRepo({
      memoryDir,
      agentId,
      files: [],
    });
    await seedDefaultPersonalityFiles(
      agentId,
      memoryDir,
      "local",
      options?.agentTags,
    );
    settingsManager.setMemfsEnabled(agentId, true);
    return { action: "enabled", memoryDir };
  }

  if (!backend.capabilities.remoteMemfs) {
    if (memfsFlag) {
      throw new Error("MemFS is not supported by the active backend.");
    }
    return { action: "unchanged" };
  }

  if (memfsFlag && !(await isLettaMemfsServer())) {
    throw new Error(await getMemfsSyncUnavailableMessage());
  }

  const localMemfsEnabled = settingsManager.isMemfsEnabled(agentId);
  const shouldAutoEnableFromTag =
    !memfsFlag &&
    !localMemfsEnabled &&
    Boolean(options?.agentTags?.includes(GIT_MEMORY_ENABLED_TAG));
  const enabling = Boolean(memfsFlag || shouldAutoEnableFromTag);

  if (enabling) {
    if (!options?.skipPromptUpdate) {
      const { updateAgentSystemPromptMemfs } = await import("@/agent/modify");
      const promptUpdate = await updateAgentSystemPromptMemfs(agentId);
      if (!promptUpdate.success) {
        throw new Error(promptUpdate.message);
      }
    }
    settingsManager.setMemfsEnabled(agentId, true);
  }

  const isEnabled = enabling || localMemfsEnabled;

  let pullSummary: string | undefined;
  if (isEnabled) {
    const { addGitMemoryTag, isGitRepo, cloneMemoryRepo, pullMemory } =
      await import("@/agent/memory-git");
    await addGitMemoryTag(
      agentId,
      options?.agentTags ? { tags: options.agentTags } : undefined,
    );
    if (!isGitRepo(agentId)) {
      await cloneMemoryRepo(agentId);
    } else if (options?.pullOnExistingRepo) {
      const result = await pullMemory(agentId, {
        throwOnFailure: options?.throwOnPullFailure,
      });
      pullSummary = result.summary;
    } else {
      installMemoryGitHooks(getScopedMemoryFilesystemRoot(agentId));
    }

    await seedDefaultPersonalityFiles(
      agentId,
      getScopedMemoryFilesystemRoot(agentId),
      "remote",
      options?.agentTags,
    );

    if (enabling && !options?.skipPromptUpdate) {
      const { getClient } = await import("@/backend/api/client");
      const client = await getClient();
      await client.agents.recompile(agentId, { update_timestamp: false });
    }

    const { initSecretsFromServer } = await import("@/utils/secrets-store");
    try {
      await initSecretsFromServer(agentId);
    } catch {}
  }

  return {
    action: enabling ? "enabled" : "unchanged",
    memoryDir: isEnabled ? getScopedMemoryFilesystemRoot(agentId) : undefined,
    pullSummary,
  };
}

export async function isLettaCloud(): Promise<boolean> {
  const { getServerUrl } = await import("@/backend/api/server-url");
  const serverUrl = getServerUrl();

  return (
    serverUrl.includes("api.letta.com") ||
    process.env.LETTA_MEMFS_LOCAL === "1" ||
    process.env.LETTA_API_KEY === "local-desktop"
  );
}

function getServerHostLabel(serverUrl: string): string {
  const trimmed = serverUrl.trim();
  try {
    return new URL(trimmed).host || trimmed;
  } catch {
    return trimmed.replace(/^https?:\/\//, "").replace(/\/+$/, "") || trimmed;
  }
}

export async function isLettaMemfsServer(): Promise<boolean> {
  const { getMemfsServerUrl } = await import("@/backend/api/memfs-git-proxy");
  const memfsServerUrl = getMemfsServerUrl();

  return (
    memfsServerUrl.includes("api.letta.com") ||
    process.env.LETTA_MEMFS_LOCAL === "1" ||
    process.env.LETTA_API_KEY === "local-desktop"
  );
}

async function getMemfsSyncUnavailableMessage(): Promise<string> {
  const { getMemfsServerUrl } = await import("@/backend/api/memfs-git-proxy");
  const memfsServerUrl = getMemfsServerUrl();
  return `MemFS sync failed (expected api.letta.com, got ${getServerHostLabel(memfsServerUrl)})`;
}

export interface EnableMemfsIfCloudOptions {
  backend?: Backend;
  agentTags?: string[] | null;
}

export async function enableMemfsIfCloud(
  agentId: string,
  options: EnableMemfsIfCloudOptions = {},
): Promise<void> {
  const resolvedBackend =
    options.backend ?? (await import("@/backend")).getBackend();
  if (!resolvedBackend.capabilities.remoteMemfs) return;
  if (!(await isLettaCloud())) return;

  try {
    await applyMemfsFlags(agentId, true, {
      agentTags: options.agentTags ?? undefined,
      skipPromptUpdate: true,
    });
  } catch (error) {
    console.warn(
      `Warning: Could not enable memfs for new agent: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
