import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  buildFsSandboxPolicy,
  type FsSandboxPolicy,
  normalizeSandboxPath,
} from "@/sandbox/policy";
import {
  getLocalBackendCrossAgentTreeRoot,
  getLocalBackendStorageDir,
} from "@/utils/local-backend-paths";
import {
  hasGlobalConfigDirOverride,
  resolveGlobalConfigDir,
} from "@/utils/settings-path";

export function getDefaultAgentsTreeRoot(
  homeDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configDir =
    homeDir === undefined || hasGlobalConfigDirOverride(env)
      ? resolveGlobalConfigDir(env, homeDir)
      : join(homeDir, ".letta");
  return canonicalizeRoot(join(configDir, "agents"));
}

export interface CrossBackendAgentsTreeRootsOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  localBackendStorageDir?: string | null;
}

export function getCrossBackendAgentsTreeRoots(
  options: CrossBackendAgentsTreeRootsOptions = {},
): string[] {
  const homeDir = options.homeDir;
  const env = options.env ?? process.env;
  const resolvedHome = homeDir ?? env.HOME ?? homedir();
  const configRoots = new Set([
    resolveGlobalConfigDir(env, resolvedHome),
    join(resolvedHome, ".letta"),
  ]);
  const localBackendStorageDir =
    options.localBackendStorageDir ?? getLocalBackendStorageDir(homeDir, env);
  const roots = new Set<string>();

  for (const configRoot of configRoots) {
    roots.add(canonicalizeRoot(join(configRoot, "agents")));
  }
  roots.add(
    canonicalizeRoot(getLocalBackendCrossAgentTreeRoot(localBackendStorageDir)),
  );
  for (const configRoot of configRoots) {
    roots.add(
      canonicalizeRoot(
        getLocalBackendCrossAgentTreeRoot(join(configRoot, "lc-local-backend")),
      ),
    );
  }

  return [...roots];
}

export function getLettaHomeRoot(
  homeDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configDir =
    homeDir === undefined || hasGlobalConfigDirOverride(env)
      ? resolveGlobalConfigDir(env, homeDir)
      : join(homeDir, ".letta");
  return canonicalizeRoot(configDir);
}

export function canonicalizeRoot(input: string): string {
  const abs = isAbsolute(input) ? input : resolve(input);

  let dir = abs;
  const tail: string[] = [];
  while (!existsSync(dir)) {
    tail.unshift(basename(dir));
    const parent = dirname(dir);
    if (parent === dir) {
      return normalizeSandboxPath(abs);
    }
    dir = parent;
  }

  try {
    const real = realpathSync(dir);
    return normalizeSandboxPath(tail.length ? join(real, ...tail) : real);
  } catch {
    return normalizeSandboxPath(abs);
  }
}

function isWithinRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function isAncestorOfRoot(path: string, root: string): boolean {
  const prefix = path === "/" ? "/" : `${path}/`;
  return root.startsWith(prefix);
}

function isTreeOrAncestorOfTree(
  path: string,
  canonicalTrees: string[],
): boolean {
  return canonicalTrees.some(
    (tree) => path === tree || isAncestorOfRoot(path, tree),
  );
}

function resolveAgentsTreeRootsInput(roots?: string[]): string[] {
  return roots?.length
    ? roots.map(canonicalizeRoot)
    : getCrossBackendAgentsTreeRoots();
}

export function deriveSelfAgentRootsForTrees(
  memoryRoots: string[],
  agentsTreeRoots: string[] = getCrossBackendAgentsTreeRoots(),
): string[] {
  const canonicalTrees = agentsTreeRoots.map(canonicalizeRoot);
  const out = new Set<string>();
  for (const root of memoryRoots) {
    const canon = canonicalizeRoot(root);
    const containingTree = canonicalTrees.find(
      (tree) => canon !== tree && isWithinRoot(canon, tree),
    );
    if (containingTree) {
      const leaf = basename(canon);
      const parentLeaf = basename(dirname(canon));
      out.add(
        leaf === "memory" || leaf === "memory-worktrees"
          ? dirname(canon)
          : parentLeaf === "memory-worktrees" ||
              (parentLeaf === "memory" && leaf === ".git")
            ? dirname(dirname(canon))
            : canon,
      );
      continue;
    }
    if (!isTreeOrAncestorOfTree(canon, canonicalTrees)) {
      out.add(canon);
    }
  }
  return [...out];
}

function deriveWritableMemoryRootsForTrees(
  memoryRoots: string[],
  agentsTreeRoots: string[],
): string[] {
  const canonicalTrees = agentsTreeRoots.map(canonicalizeRoot);
  const out = new Set<string>();
  for (const root of memoryRoots) {
    const canon = canonicalizeRoot(root);
    const isExactDeniedTree = canonicalTrees.includes(canon);
    const isInsideDeniedTree = canonicalTrees.some(
      (tree) => canon !== tree && isWithinRoot(canon, tree),
    );

    if (
      !isExactDeniedTree &&
      (isInsideDeniedTree || !isTreeOrAncestorOfTree(canon, canonicalTrees))
    ) {
      out.add(canon);
    }
  }
  return [...out];
}

export interface MemorySubagentSandboxInput {
  memoryRoots: string[];
  readonlyRoots?: string[];
  harnessWritableRoots?: string[];
  agentsTreeRoots?: string[];
}

export function buildMemorySubagentSandboxPolicy(
  input: MemorySubagentSandboxInput,
): FsSandboxPolicy {
  const agentsTreeRoots = resolveAgentsTreeRootsInput(input.agentsTreeRoots);

  const baseWritableRoots = [
    getLettaHomeRoot(),
    ...(input.harnessWritableRoots ?? []),
  ].map(canonicalizeRoot);

  return buildFsSandboxPolicy({
    baseWritableRoots,
    deniedRoots: agentsTreeRoots,
    readonlyRoots: [
      ...deriveSelfAgentRootsForTrees(input.memoryRoots, agentsTreeRoots),
      ...(input.readonlyRoots ?? []).map(canonicalizeRoot),
    ],
    writableRoots: deriveWritableMemoryRootsForTrees(
      input.memoryRoots,
      agentsTreeRoots,
    ),
    restrictWrites: true,
  });
}

export interface CrossAgentSandboxInput {
  selfRoots: string[];
  agentsTreeRoots?: string[];
}

export function buildCrossAgentSandboxPolicy(
  input: CrossAgentSandboxInput,
): FsSandboxPolicy {
  const agentsTreeRoots = resolveAgentsTreeRootsInput(input.agentsTreeRoots);

  return buildFsSandboxPolicy({
    deniedRoots: agentsTreeRoots,
    writableRoots: input.selfRoots.map(canonicalizeRoot),
    restrictWrites: false,
  });
}
