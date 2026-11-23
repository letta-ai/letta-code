import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCrossAgentSandboxPolicy,
  buildMemorySubagentSandboxPolicy,
  canonicalizeRoot,
  deriveSelfAgentRootsForTrees,
  getCrossBackendAgentsTreeRoots,
  getDefaultAgentsTreeRoot,
  getLettaHomeRoot,
} from "@/permissions/sandbox-policy";
import { getOrderedSandboxPathRules } from "@/sandbox/policy";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-policy-")));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

test("canonicalizeRoot resolves a symlinked directory to its real path", () => {
  const base = makeTempDir();
  const target = join(base, "real");
  mkdirSync(target);
  const link = join(base, "link");
  symlinkSync(target, link);

  expect(canonicalizeRoot(link)).toBe(canonicalizeRoot(target));
});

test("canonicalizeRoot resolves through a symlink for a not-yet-existing leaf", () => {
  const base = makeTempDir();
  const target = join(base, "real");
  mkdirSync(target);
  const link = join(base, "link");
  symlinkSync(target, link);

  expect(canonicalizeRoot(join(link, "child.txt"))).toBe(
    canonicalizeRoot(join(target, "child.txt")),
  );
});

test("getDefaultAgentsTreeRoot ends with the agents tree path", () => {
  const home = makeTempDir();
  mkdirSync(join(home, ".letta", "agents"), { recursive: true });
  expect(getDefaultAgentsTreeRoot(home)).toBe(
    canonicalizeRoot(join(home, ".letta", "agents")),
  );
});

test("memory-subagent policy: writes scoped to ~/.letta, agents tree read-denied with agent dir carved readonly", () => {
  const agentDir = join(getDefaultAgentsTreeRoot(), "memmode-self");
  const memoryRoot = join(agentDir, "memory");

  const policy = buildMemorySubagentSandboxPolicy({
    memoryRoots: [memoryRoot],
  });

  expect(policy.restrictWrites).toBe(true);
  expect(policy.baseWritableRoots).toEqual([getLettaHomeRoot()]);
  expect(policy.baseWritableRoots).not.toContain(canonicalizeRoot("/tmp"));
  expect(policy.writableRoots).toEqual([canonicalizeRoot(memoryRoot)]);
  expect(policy.deniedRoots).toEqual(getCrossBackendAgentsTreeRoots());
  expect(policy.readonlyRoots).toEqual([canonicalizeRoot(agentDir)]);
});

test("memory-subagent policy folds harness roots outside ~/.letta into the base", () => {
  const agentDir = join(getDefaultAgentsTreeRoot(), "memmode-self");
  const memoryRoot = join(agentDir, "memory");
  const extra = makeTempDir();

  const policy = buildMemorySubagentSandboxPolicy({
    memoryRoots: [memoryRoot],
    harnessWritableRoots: [extra],
  });

  expect(policy.baseWritableRoots).toContain(getLettaHomeRoot());
  expect(policy.baseWritableRoots).toContain(canonicalizeRoot(extra));
  expect(policy.baseWritableRoots).not.toContain(canonicalizeRoot("/tmp"));
});

test("memory-subagent policy (local backend): custom tree, ~/.letta base, self memory re-carved", () => {
  const home = makeTempDir();
  const storage = join(home, ".letta", "lc-local-backend");
  const memfsTree = join(storage, "memfs");
  const selfAgentDir = join(memfsTree, "agent-self");
  const memoryRoot = join(selfAgentDir, "memory");
  mkdirSync(memoryRoot, { recursive: true });

  const policy = buildMemorySubagentSandboxPolicy({
    memoryRoots: [memoryRoot],
    agentsTreeRoots: [memfsTree],
    harnessWritableRoots: [storage],
  });

  expect(policy.restrictWrites).toBe(true);
  expect(policy.deniedRoots).toEqual([canonicalizeRoot(memfsTree)]);
  expect(policy.readonlyRoots).toEqual([canonicalizeRoot(selfAgentDir)]);
  expect(policy.writableRoots).toEqual([canonicalizeRoot(memoryRoot)]);
  expect(policy.baseWritableRoots).toContain(canonicalizeRoot(storage));
});

test("memory-subagent policy: defaults to both backend trees with write-scoping on", () => {
  const agentDir = join(getDefaultAgentsTreeRoot(), "memmode-default");
  const memoryRoot = join(agentDir, "memory");

  const policy = buildMemorySubagentSandboxPolicy({
    memoryRoots: [memoryRoot],
  });

  expect(policy.restrictWrites).toBe(true);
  expect(policy.deniedRoots).toEqual(getCrossBackendAgentsTreeRoots());
});

test("cross-agent policy denies the agents tree and carves out self", () => {
  const home = makeTempDir();
  const agentsTree = join(home, ".letta", "agents");
  const selfDir = join(agentsTree, "self");
  mkdirSync(selfDir, { recursive: true });

  const policy = buildCrossAgentSandboxPolicy({
    selfRoots: [selfDir],
    agentsTreeRoots: [agentsTree],
  });

  expect(policy.restrictWrites).toBe(false);
  expect(policy.deniedRoots).toEqual([canonicalizeRoot(agentsTree)]);
  expect(policy.writableRoots).toEqual([canonicalizeRoot(selfDir)]);
});

test("cross-agent policy defaults to both backend agents trees", () => {
  const policy = buildCrossAgentSandboxPolicy({
    selfRoots: [canonicalizeRoot("/tmp")],
  });

  expect(policy.deniedRoots).toEqual(getCrossBackendAgentsTreeRoots());
});

test("product isolation walls off active and legacy API and local trees", () => {
  const home = makeTempDir();
  const productRoot = join(home, ".dream");
  const roots = getCrossBackendAgentsTreeRoots({
    homeDir: home,
    env: {
      HOME: home,
      LETTA_CONFIG_DIR: productRoot,
    } as NodeJS.ProcessEnv,
  });

  expect(new Set(roots)).toEqual(
    new Set(
      [productRoot, join(home, ".letta")].flatMap((configRoot) => [
        canonicalizeRoot(join(configRoot, "agents")),
        canonicalizeRoot(join(configRoot, "lc-local-backend", "memfs")),
      ]),
    ),
  );
});

test("nested explicit storage is remasked after self carves", () => {
  const home = makeTempDir();
  const agentsTree = join(home, ".letta", "agents");
  const selfRoot = join(agentsTree, "self");
  const selfMemory = join(selfRoot, "memory");
  const nestedTree = join(selfMemory, "local-store", "memfs");
  const innerSelfMemory = join(nestedTree, "self", "memory");
  const deniedRoots = [agentsTree, nestedTree];

  const parentPolicy = buildCrossAgentSandboxPolicy({
    selfRoots: [selfMemory, innerSelfMemory],
    agentsTreeRoots: deniedRoots,
  });
  const memoryPolicy = buildMemorySubagentSandboxPolicy({
    memoryRoots: [selfMemory, innerSelfMemory],
    agentsTreeRoots: deniedRoots,
  });

  expect(memoryPolicy.writableRoots).toContain(canonicalizeRoot(selfMemory));
  expect(memoryPolicy.writableRoots).toContain(
    canonicalizeRoot(innerSelfMemory),
  );

  for (const policy of [parentPolicy, memoryPolicy]) {
    const rules = getOrderedSandboxPathRules(policy);
    const indexOf = (kind: string, root: string) =>
      rules.findIndex(
        (rule) => rule.kind === kind && rule.root === canonicalizeRoot(root),
      );
    const outerSelfIndex = indexOf("writable", selfMemory);
    const nestedDenyIndex = indexOf("deny", nestedTree);
    const innerSelfIndex = indexOf("writable", innerSelfMemory);
    expect(outerSelfIndex).toBeGreaterThan(-1);
    expect(nestedDenyIndex).toBeGreaterThan(-1);
    expect(innerSelfIndex).toBeGreaterThan(-1);
    expect(outerSelfIndex).toBeLessThan(nestedDenyIndex);
    expect(innerSelfIndex).toBeGreaterThan(nestedDenyIndex);
  }
});

test("deriveSelfAgentRootsForTrees collapses in-tree memory roots to the agent dir", () => {
  const tree = getDefaultAgentsTreeRoot();
  const agentDir = join(tree, "abc");
  const roots = deriveSelfAgentRootsForTrees(
    [join(agentDir, "memory"), join(agentDir, "memory-worktrees")],
    [tree],
  );
  expect(roots).toEqual([canonicalizeRoot(agentDir)]);
});

test("deriveSelfAgentRootsForTrees collapses specific memory worktrees to the agent dir", () => {
  const tree = getDefaultAgentsTreeRoot();
  const agentDir = join(tree, "abc");
  const roots = deriveSelfAgentRootsForTrees(
    [join(agentDir, "memory-worktrees", "reflection-123")],
    [tree],
  );
  expect(roots).toEqual([canonicalizeRoot(agentDir)]);
});

test("memory-subagent policy can write an exact reflection worktree and parent git metadata", () => {
  const tree = getDefaultAgentsTreeRoot();
  const agentDir = join(tree, "abc");
  const reflectionWorktree = join(
    agentDir,
    "memory-worktrees",
    "reflection-123",
  );
  const gitCommonDir = join(agentDir, "memory", ".git");

  const policy = buildMemorySubagentSandboxPolicy({
    memoryRoots: [reflectionWorktree, gitCommonDir],
  });

  expect(policy.writableRoots).toEqual([
    canonicalizeRoot(reflectionWorktree),
    canonicalizeRoot(gitCommonDir),
  ]);
  expect(policy.readonlyRoots).toEqual([canonicalizeRoot(agentDir)]);
  expect(policy.writableRoots).not.toContain(
    canonicalizeRoot(join(agentDir, "memory")),
  );
});

test("deriveSelfAgentRootsForTrees keeps roots outside the tree as-is", () => {
  const tree = getDefaultAgentsTreeRoot();
  const outside = canonicalizeRoot(join(tmpdir(), "letta-outside-fixture"));
  expect(deriveSelfAgentRootsForTrees([outside], [tree])).toEqual([outside]);
});

test("deriveSelfAgentRootsForTrees refuses to carve the whole tree or its ancestors", () => {
  const tree = getDefaultAgentsTreeRoot();
  expect(deriveSelfAgentRootsForTrees([tree], [tree])).toEqual([]);
  expect(deriveSelfAgentRootsForTrees([getLettaHomeRoot()], [tree])).toEqual(
    [],
  );
});
