/**
 * Memory filesystem helpers.
 *
 * With git-backed memory, most sync/hash logic is removed.
 * This module retains: directory helpers, tree rendering, and
 * the shared memfs initialization logic used by both interactive
 * and headless code paths.
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DIRECTORY_LIMIT_DEFAULTS,
  getDirectoryLimits,
} from "../utils/directoryLimits";

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

// ----- Directory helpers -----

export function getMemoryFilesystemRoot(
  agentId: string,
  homeDir: string = homedir(),
): string {
  return join(
    homeDir,
    MEMORY_FS_ROOT,
    MEMORY_FS_AGENTS_DIR,
    agentId,
    MEMORY_FS_MEMORY_DIR,
  );
}

export function getMemorySystemDir(
  agentId: string,
  homeDir: string = homedir(),
): string {
  return join(getMemoryFilesystemRoot(agentId, homeDir), MEMORY_SYSTEM_DIR);
}

export function ensureMemoryFilesystemDirs(
  agentId: string,
  homeDir: string = homedir(),
): void {
  const root = getMemoryFilesystemRoot(agentId, homeDir);
  const systemDir = getMemorySystemDir(agentId, homeDir);

  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
  }
  if (!existsSync(systemDir)) {
    mkdirSync(systemDir, { recursive: true });
  }
}

/**
 * Returns whether memfs is enabled for the agent on the server.
 *
 * This is a read-only check used by desktop/listener surfaces that need to
 * distinguish "memfs disabled" from "enabled but local checkout missing"
 * without mutating agent configuration.
 */
export async function isMemfsEnabledOnServer(
  agentId: string,
): Promise<boolean> {
  const { getClient } = await import("./client");
  const client = await getClient();
  const agent = await client.agents.retrieve(agentId);
  const { GIT_MEMORY_ENABLED_TAG } = await import("./memoryGit");
  const enabled = agent.tags?.includes(GIT_MEMORY_ENABLED_TAG) ?? false;

  const { settingsManager } = await import("../settings-manager");
  settingsManager.setMemfsEnabled(agentId, enabled);

  return enabled;
}

/**
 * Ensures the local memfs checkout exists for an already-enabled agent.
 *
 * Unlike applyMemfsFlags(), this helper does not update prompts, tags, tools,
 * or other agent configuration. It only materializes the local git checkout
 * when the repo is missing.
 */
export async function ensureLocalMemfsCheckout(agentId: string): Promise<void> {
  const { isGitRepo, cloneMemoryRepo } = await import("./memoryGit");
  if (isGitRepo(agentId)) {
    return;
  }
  await cloneMemoryRepo(agentId);
}

// ----- Path helpers -----

export function labelFromRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  return normalized.replace(/\.md$/, "");
}

// ----- Tree rendering -----

/**
 * Render a tree visualization of the memory filesystem.
 * Takes system labels (under system/) and detached labels (at root).
 */
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

  // Always show system/ directory even if empty
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
      const shownEntries = Math.max(0, lines.length - 1); // Exclude /memory/
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

// ----- Shared memfs initialization -----

export interface ApplyMemfsFlagsResult {
  /** Whether memfs was enabled, disabled, or unchanged */
  action: "enabled" | "disabled" | "unchanged";
  /** Path to the memory directory (when enabled) */
  memoryDir?: string;
  /** Summary from git pull (when pullOnExistingRepo is true and repo already existed) */
  pullSummary?: string;
}

export interface ApplyMemfsFlagsOptions {
  pullOnExistingRepo?: boolean;
  agentTags?: string[];
  /** Skip the system prompt update (when the agent was created with the correct mode). */
  skipPromptUpdate?: boolean;
}

/**
 * Apply --memfs / --no-memfs CLI flags (or /memfs enable) to an agent.
 *
 * Shared between interactive (index.ts), headless (headless.ts), and
 * the /memfs enable command (App.tsx) to avoid duplicating the setup logic.
 *
 * Steps when toggling:
 *   1. Validate Letta Cloud requirement (for explicit enable)
 *   2. Reconcile system prompt to the target memory mode
 *   3. Persist memfs setting locally
 *   4. Detach old API-based memory tools (when enabling)
 *   5. Add git-memory-enabled tag + clone/pull repo
 *
 * @throws {Error} if Letta Cloud validation fails or git setup fails
 */
export async function applyMemfsFlags(
  agentId: string,
  memfsFlag: boolean | undefined,
  noMemfsFlag: boolean | undefined,
  options?: ApplyMemfsFlagsOptions,
): Promise<ApplyMemfsFlagsResult> {
  const { settingsManager } = await import("../settings-manager");

  // Validate explicit enable on supported backend.
  if (memfsFlag && !(await isLettaCloud())) {
    throw new Error(
      "--memfs is only available on Letta Cloud (api.letta.com).",
    );
  }

  const hasExplicitToggle = Boolean(memfsFlag || noMemfsFlag);
  const localMemfsEnabled = settingsManager.isMemfsEnabled(agentId);
  const { GIT_MEMORY_ENABLED_TAG } = await import("./memoryGit");
  const shouldAutoEnableFromTag =
    !hasExplicitToggle &&
    !localMemfsEnabled &&
    Boolean(options?.agentTags?.includes(GIT_MEMORY_ENABLED_TAG));
  const targetEnabled = memfsFlag
    ? true
    : noMemfsFlag
      ? false
      : shouldAutoEnableFromTag
        ? true
        : localMemfsEnabled;

  // 2. Reconcile system prompt first, then persist local memfs setting.
  if (hasExplicitToggle || shouldAutoEnableFromTag) {
    if (!options?.skipPromptUpdate) {
      const { updateAgentSystemPromptMemfs } = await import("./modify");
      const promptUpdate = await updateAgentSystemPromptMemfs(
        agentId,
        targetEnabled,
      );
      if (!promptUpdate.success) {
        throw new Error(promptUpdate.message);
      }
      // Force recompile of the system message so the updated template
      // (with/without memfs addon) is reflected in the compiled prompt.
      const { getClient } = await import("./client");
      const client = await getClient();
      await client.agents.recompile(agentId, { update_timestamp: false });
    }
    settingsManager.setMemfsEnabled(agentId, targetEnabled);
  }

  const isEnabled =
    hasExplicitToggle || shouldAutoEnableFromTag
      ? targetEnabled
      : settingsManager.isMemfsEnabled(agentId);

  // 3. Detach old API-based memory tools when enabling.
  if (isEnabled && (memfsFlag || shouldAutoEnableFromTag)) {
    const { detachMemoryTools } = await import("../tools/toolset");
    await detachMemoryTools(agentId);

    // Migration (LET-7353): Remove legacy skills/loaded_skills blocks.
    // These blocks are no longer used — skills are now injected via system reminders.
    const { getClient } = await import("./client");
    const client = await getClient();
    for (const label of ["skills", "loaded_skills"]) {
      try {
        const block = await client.agents.blocks.retrieve(label, {
          agent_id: agentId,
        });
        if (block) {
          await client.agents.blocks.detach(block.id, {
            agent_id: agentId,
          });
          await client.blocks.delete(block.id);
        }
      } catch {
        // Block doesn't exist or already removed, skip
      }
    }
  }

  // Keep server-side state aligned with explicit disable.
  if (noMemfsFlag) {
    const { removeGitMemoryTag } = await import("./memoryGit");
    await removeGitMemoryTag(agentId);
  }

  // 4. Add git tag + clone/pull repo.
  let pullSummary: string | undefined;
  if (isEnabled) {
    const { addGitMemoryTag, isGitRepo, cloneMemoryRepo, pullMemory } =
      await import("./memoryGit");
    await addGitMemoryTag(
      agentId,
      options?.agentTags ? { tags: options.agentTags } : undefined,
    );
    if (!isGitRepo(agentId)) {
      await cloneMemoryRepo(agentId);
    } else if (options?.pullOnExistingRepo) {
      const result = await pullMemory(agentId);
      pullSummary = result.summary;
    }

    // Fetch secrets from the server so they're available for $SECRET_NAME substitution.
    const { initSecretsFromServer } = await import("../utils/secretsStore");
    try {
      await initSecretsFromServer(agentId);
    } catch {
      // Non-fatal: secrets substitution won't work but agent can still run.
    }
  }

  const action =
    memfsFlag || shouldAutoEnableFromTag
      ? "enabled"
      : noMemfsFlag
        ? "disabled"
        : "unchanged";
  return {
    action,
    memoryDir: isEnabled ? getMemoryFilesystemRoot(agentId) : undefined,
    pullSummary,
  };
}

/**
 * Whether the current server is Letta Cloud (or local memfs testing is enabled).
 */
export async function isLettaCloud(): Promise<boolean> {
  const { getServerUrl } = await import("./client");
  const serverUrl = getServerUrl();

  return (
    serverUrl.includes("api.letta.com") ||
    process.env.LETTA_MEMFS_LOCAL === "1" ||
    process.env.LETTA_API_KEY === "local-desktop"
  );
}

/**
 * Enable memfs for a newly created agent if on Letta Cloud.
 * Non-fatal: logs a warning on failure. Skips on self-hosted.
 *
 * Skips the system prompt update since callers are expected to create
 * the agent with the correct memory mode upfront.
 */
export async function enableMemfsIfCloud(agentId: string): Promise<void> {
  if (!(await isLettaCloud())) return;

  try {
    await applyMemfsFlags(agentId, true, undefined, {
      skipPromptUpdate: true,
    });
  } catch (error) {
    console.warn(
      `Warning: Could not enable memfs for new agent: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
