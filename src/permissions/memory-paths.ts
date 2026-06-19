import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import { getCurrentAgentId } from "@/agent/context";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";

export interface ResolveAllowedMemoryRootsOptions {
  env?: NodeJS.ProcessEnv;
  currentAgentId?: string | null;
  parentAgentId?: string | null;
  homeDir?: string;
}

export interface ResolvedMemoryRoots {
  roots: string[];
  primaryRoot: string | null;
  usedFallback: boolean;
}

export function normalizeMemoryPath(path: string): string {
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

export function resolveMemoryTargetPath(
  targetPath: string,
  workingDirectory: string,
): string | null {
  const trimmedPath = targetPath.trim();
  if (!trimmedPath) return null;

  if (trimmedPath.startsWith("~/") || trimmedPath.startsWith("$HOME/")) {
    return normalizeMemoryPath(trimmedPath);
  }
  if (isAbsolute(trimmedPath) || /^[a-zA-Z]:[\\/]/.test(trimmedPath)) {
    return normalizeMemoryPath(trimmedPath);
  }
  return normalizeMemoryPath(resolve(workingDirectory, trimmedPath));
}

export function isPathWithinRoots(path: string, roots: string[]): boolean {
  const normalizedPath = normalizeMemoryPath(path);
  return roots.some((root) => {
    const normalizedRoot = normalizeMemoryPath(root);
    return (
      normalizedPath === normalizedRoot ||
      normalizedPath.startsWith(`${normalizedRoot}/`)
    );
  });
}

function addRootAndSiblingWorktree(root: string, acc: Set<string>): void {
  const normalizedRoot = normalizeMemoryPath(root);
  if (!normalizedRoot) {
    return;
  }

  acc.add(normalizedRoot);

  const leaf = basename(normalizedRoot);
  if (leaf === "memory") {
    acc.add(
      normalizeMemoryPath(resolve(dirname(normalizedRoot), "memory-worktrees")),
    );
  }
}

interface ExplicitEnvRoots {
  roots: string[];
  primaryRoot: string | null;
}

function getExplicitEnvRoots(env: NodeJS.ProcessEnv): ExplicitEnvRoots {
  const orderedRoots = [env.MEMORY_DIR, env.LETTA_MEMORY_DIR]
    .map((value) => value?.trim() ?? "")
    .filter((value) => value.length > 0);

  const rootSet = new Set<string>();
  for (const root of orderedRoots) {
    addRootAndSiblingWorktree(root, rootSet);
  }

  return {
    roots: [...rootSet],
    primaryRoot:
      orderedRoots.length > 0
        ? normalizeMemoryPath(orderedRoots[0] as string)
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

  try {
    const fromContext = getCurrentAgentId().trim();
    return fromContext || null;
  } catch {
    const envAgentId = (env.AGENT_ID || env.LETTA_AGENT_ID || "").trim();
    return envAgentId || null;
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
  const envParentAgentId =
    env.LETTA_CODE_AGENT_ROLE === "subagent" ? env.LETTA_PARENT_AGENT_ID : "";
  const resolvedParentAgentId =
    (parentAgentId || envParentAgentId || "").trim() || null;

  let primaryRoot: string | null = null;

  if (resolvedCurrentAgentId) {
    const currentRoot = getScopedMemoryFilesystemRoot(resolvedCurrentAgentId, {
      homeDir,
      env,
    });
    addRootAndSiblingWorktree(currentRoot, fallbackRoots);
    primaryRoot = normalizeMemoryPath(currentRoot);
  }

  if (
    resolvedParentAgentId &&
    resolvedParentAgentId !== resolvedCurrentAgentId
  ) {
    const parentRoot = getScopedMemoryFilesystemRoot(resolvedParentAgentId, {
      homeDir,
      env,
    });
    addRootAndSiblingWorktree(parentRoot, fallbackRoots);
    if (!primaryRoot) {
      primaryRoot = normalizeMemoryPath(parentRoot);
    }
  }

  return {
    roots: [...fallbackRoots],
    primaryRoot,
  };
}

export function resolveAllowedMemoryRoots(
  options: ResolveAllowedMemoryRootsOptions = {},
): ResolvedMemoryRoots {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();

  const explicit = getExplicitEnvRoots(env);
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
