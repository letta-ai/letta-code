import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import { getCurrentAgentId } from "../agent/context";
import { getMemoryFilesystemRoot } from "../agent/memoryFilesystem";
import { cliPermissions } from "./cli";

export interface ResolveAllowedMemoryRootsOptions {
  env?: NodeJS.ProcessEnv;
  currentAgentId?: string | null;
  parentAgentId?: string | null;
  homeDir?: string;
}

export interface ResolvedMemoryScope {
  roots: string[];
  primaryRoot: string | null;
  usedFallback: boolean;
}

export function normalizeScopedPath(path: string): string {
  const resolvedPath = resolve(expandHomePath(path));
  const normalized = resolvedPath.replace(/\\/g, "/");
  return normalized.replace(/\/+$/, "") || "/";
}

export function expandHomePath(path: string): string {
  const value = path.trim();
  const homeDir = homedir();

  if (value.startsWith("~/")) {
    return resolve(homeDir, value.slice(2));
  }
  if (value.startsWith("$HOME/")) {
    return resolve(homeDir, value.slice(6));
  }
  if (value.startsWith('"$HOME/')) {
    return resolve(homeDir, value.slice(7).replace(/"$/, ""));
  }

  return value;
}

export function resolveScopedTargetPath(
  targetPath: string,
  workingDirectory: string,
): string | null {
  const trimmedPath = targetPath.trim();
  if (!trimmedPath) return null;

  if (trimmedPath.startsWith("~/") || trimmedPath.startsWith("$HOME/")) {
    return normalizeScopedPath(trimmedPath);
  }
  if (isAbsolute(trimmedPath) || /^[a-zA-Z]:[\\/]/.test(trimmedPath)) {
    return normalizeScopedPath(trimmedPath);
  }
  return normalizeScopedPath(resolve(workingDirectory, trimmedPath));
}

export function isPathWithinRoots(path: string, roots: string[]): boolean {
  const normalizedPath = normalizeScopedPath(path);
  return roots.some((root) => {
    const normalizedRoot = normalizeScopedPath(root);
    return (
      normalizedPath === normalizedRoot ||
      normalizedPath.startsWith(`${normalizedRoot}/`)
    );
  });
}

function addRootAndSiblingWorktree(root: string, acc: Set<string>): void {
  const normalizedRoot = normalizeScopedPath(root);
  if (!normalizedRoot) {
    return;
  }

  acc.add(normalizedRoot);

  const leaf = basename(normalizedRoot);
  if (leaf === "memory") {
    acc.add(
      normalizeScopedPath(resolve(dirname(normalizedRoot), "memory-worktrees")),
    );
  }
}

/**
 * Parse a comma- or whitespace-separated list of agent IDs.
 * Used for both `LETTA_MEMORY_SCOPE` env var and `--memory-scope` CLI flag.
 */
export function parseScopeList(value: string | undefined | null): string[] {
  if (!value) return [];
  return value
    .split(/[\s,]+/)
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

interface ExplicitEnvRoots {
  roots: string[];
  primaryRoot: string | null;
}

function getExplicitEnvRoots(
  env: NodeJS.ProcessEnv,
  homeDir: string,
): ExplicitEnvRoots {
  const orderedRoots = [env.MEMORY_DIR, env.LETTA_MEMORY_DIR]
    .map((value) => value?.trim() ?? "")
    .filter((value) => value.length > 0);

  const rootSet = new Set<string>();
  for (const root of orderedRoots) {
    addRootAndSiblingWorktree(root, rootSet);
  }

  // Include memory roots for every agent ID in the cross-agent scope
  // (env LETTA_MEMORY_SCOPE + CLI --memory-scope). This keeps memory-mode
  // write permissions aligned with the cross-agent guard.
  const scopeIds = new Set<string>([
    ...parseScopeList(env.LETTA_MEMORY_SCOPE),
    ...cliPermissions.getMemoryScope(),
  ]);
  for (const id of scopeIds) {
    addRootAndSiblingWorktree(getMemoryFilesystemRoot(id, homeDir), rootSet);
  }

  return {
    roots: [...rootSet],
    primaryRoot:
      orderedRoots.length > 0
        ? normalizeScopedPath(orderedRoots[0] as string)
        : null,
  };
}

/**
 * Resolve the current agent ID from: (1) the explicit argument, (2) the
 * `AGENT_ID` / `LETTA_AGENT_ID` env vars, or (3) the in-process agent
 * context. Returns null when none of those sources yields a non-empty ID.
 */
export function deriveAgentId(
  env: NodeJS.ProcessEnv,
  explicitAgentId?: string | null,
): string | null {
  const explicit = explicitAgentId?.trim();
  if (explicit) return explicit;

  const envAgentId = (env.AGENT_ID || env.LETTA_AGENT_ID || "").trim();
  if (envAgentId) return envAgentId;

  try {
    const fromContext = getCurrentAgentId().trim();
    return fromContext || null;
  } catch {
    return null;
  }
}

interface FallbackRoots {
  roots: string[];
  primaryRoot: string | null;
}

function getFallbackRoots(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  currentAgentId?: string | null,
  parentAgentId?: string | null,
): FallbackRoots {
  const fallbackRoots = new Set<string>();

  const resolvedCurrentAgentId = deriveAgentId(env, currentAgentId);
  const resolvedParentAgentId =
    (parentAgentId || env.LETTA_PARENT_AGENT_ID || "").trim() || null;

  let primaryRoot: string | null = null;

  if (resolvedCurrentAgentId) {
    const currentRoot = getMemoryFilesystemRoot(
      resolvedCurrentAgentId,
      homeDir,
    );
    addRootAndSiblingWorktree(currentRoot, fallbackRoots);
    primaryRoot = normalizeScopedPath(currentRoot);
  }

  if (
    resolvedParentAgentId &&
    resolvedParentAgentId !== resolvedCurrentAgentId
  ) {
    const parentRoot = getMemoryFilesystemRoot(resolvedParentAgentId, homeDir);
    addRootAndSiblingWorktree(parentRoot, fallbackRoots);
    if (!primaryRoot) {
      primaryRoot = normalizeScopedPath(parentRoot);
    }
  }

  return {
    roots: [...fallbackRoots],
    primaryRoot,
  };
}

export function resolveAllowedMemoryRoots(
  options: ResolveAllowedMemoryRootsOptions = {},
): ResolvedMemoryScope {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();

  const explicit = getExplicitEnvRoots(env, homeDir);
  if (explicit.roots.length > 0) {
    return {
      roots: explicit.roots,
      primaryRoot: explicit.primaryRoot,
      usedFallback: false,
    };
  }

  const fallback = getFallbackRoots(
    env,
    homeDir,
    options.currentAgentId,
    options.parentAgentId,
  );

  return {
    roots: fallback.roots,
    primaryRoot: fallback.primaryRoot,
    usedFallback: fallback.roots.length > 0,
  };
}
