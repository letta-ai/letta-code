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

  // The file doesn't exist yet (create case) but the symlinked parent does.
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
  // Use the real agents tree so deriveSelfAgentRootsForTrees resolves the agent
  // dir (the policy always denies getDefaultAgentsTreeRoot(), keyed to homedir()).
  const agentDir = join(getDefaultAgentsTreeRoot(), "memmode-self");
  const memoryRoot = join(agentDir, "memory");

  const policy = buildMemorySubagentSandboxPolicy({
    memoryRoots: [memoryRoot],
  });

  expect(policy.restrictWrites).toBe(true);
  // Writes are scoped to the harness state dir (~/.letta) as the base — so the
  // subagent can persist harness metadata but not the repo/home/temp.
  expect(policy.baseWritableRoots).toEqual([getLettaHomeRoot()]);
  expect(policy.baseWritableRoots).not.toContain(canonicalizeRoot("/tmp"));
  // Self memory is re-carved writable (it's nested inside the denied tree, where
  // the base ~/.letta carve is overridden by the deny).
  expect(policy.writableRoots).toEqual([canonicalizeRoot(memoryRoot)]);
  // Cross-agent reads denied: the whole agents tree is walled off...
  expect(policy.deniedRoots).toEqual(getCrossBackendAgentsTreeRoots());
  // ...with the agent's own dir carved back out READ-only (env survival +
  // reading own state) — writes stay denied there by restrictWrites.
  expect(policy.readonlyRoots).toEqual([canonicalizeRoot(agentDir)]);
});

test("memory-subagent policy folds harness roots outside ~/.letta into the base", () => {
  const agentDir = join(getDefaultAgentsTreeRoot(), "memmode-self");
  const memoryRoot = join(agentDir, "memory");
  const extra = makeTempDir(); // a harness root relocated off the default tree

  const policy = buildMemorySubagentSandboxPolicy({
    memoryRoots: [memoryRoot],
    harnessWritableRoots: [extra],
  });

  // ~/.letta is always the base; explicit harness roots fold in alongside it.
  expect(policy.baseWritableRoots).toContain(getLettaHomeRoot());
  expect(policy.baseWritableRoots).toContain(canonicalizeRoot(extra));
  // No temp dir is auto-granted.
  expect(policy.baseWritableRoots).not.toContain(canonicalizeRoot("/tmp"));
});

test("memory-subagent policy (local backend): custom tree, ~/.letta base, self memory re-carved", () => {
  // The local backend walls off `lc-local-backend/memfs` (not ~/.letta/agents)
  // and stays write-scoped. The storage dir is added to the base (BEFORE the
  // deny) so conversations/agents/providers under it are writable while memfs
  // stays denied; only self memory is re-carved in the final writable set.
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
  // The memfs tree is walled off (read+write) — NOT ~/.letta/agents.
  expect(policy.deniedRoots).toEqual([canonicalizeRoot(memfsTree)]);
  // Self agent dir carved readonly (env survival + own reads).
  expect(policy.readonlyRoots).toEqual([canonicalizeRoot(selfAgentDir)]);
  // Only self memory in the final writable set (re-carved over the deny).
  expect(policy.writableRoots).toEqual([canonicalizeRoot(memoryRoot)]);
  // The storage dir is in the base (so its persistence dirs stay writable).
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

  // Default-allow writes (the repo/home stay writable); only the agents tree
  // is walled off, with self carved back out.
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

test("deriveSelfAgentRootsForTrees collapses in-tree memory roots to the agent dir", () => {
  const tree = getDefaultAgentsTreeRoot();
  const agentDir = join(tree, "abc");
  const roots = deriveSelfAgentRootsForTrees(
    [join(agentDir, "memory"), join(agentDir, "memory-worktrees")],
    [tree],
  );
  expect(roots).toEqual([canonicalizeRoot(agentDir)]);
});

test("deriveSelfAgentRootsForTrees keeps roots outside the tree as-is", () => {
  const tree = getDefaultAgentsTreeRoot();
  const outside = canonicalizeRoot("/tmp");
  expect(deriveSelfAgentRootsForTrees([outside], [tree])).toEqual([outside]);
});

test("deriveSelfAgentRootsForTrees refuses to carve the whole tree or its ancestors", () => {
  const tree = getDefaultAgentsTreeRoot();
  expect(deriveSelfAgentRootsForTrees([tree], [tree])).toEqual([]);
  expect(deriveSelfAgentRootsForTrees([getLettaHomeRoot()], [tree])).toEqual(
    [],
  );
});
