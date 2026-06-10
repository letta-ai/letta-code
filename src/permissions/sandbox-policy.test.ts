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
  buildMemoryModeSandboxPolicy,
  canonicalizeRoot,
  deriveSelfAgentRoots,
  getDefaultAgentsTreeRoot,
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

  expect(canonicalizeRoot(link)).toBe(target);
});

test("canonicalizeRoot resolves through a symlink for a not-yet-existing leaf", () => {
  const base = makeTempDir();
  const target = join(base, "real");
  mkdirSync(target);
  const link = join(base, "link");
  symlinkSync(target, link);

  // The file doesn't exist yet (create case) but the symlinked parent does.
  expect(canonicalizeRoot(join(link, "child.txt"))).toBe(
    join(target, "child.txt"),
  );
});

test("getDefaultAgentsTreeRoot ends with the agents tree path", () => {
  const home = makeTempDir();
  mkdirSync(join(home, ".letta", "agents"), { recursive: true });
  expect(getDefaultAgentsTreeRoot(home)).toBe(join(home, ".letta", "agents"));
});

test("memory-mode policy: writes scoped to memory (no temp carve), agents tree read-denied with agent dir carved readonly", () => {
  // Use the real agents tree so deriveSelfAgentRoots resolves the agent dir
  // (the policy always denies getDefaultAgentsTreeRoot(), keyed to homedir()).
  const agentDir = join(getDefaultAgentsTreeRoot(), "memmode-self");
  const memoryRoot = join(agentDir, "memory");

  const policy = buildMemoryModeSandboxPolicy({
    memoryRoots: [memoryRoot],
  });

  expect(policy.restrictWrites).toBe(true);
  // Writes scoped to the memory dir ONLY — memory mode never granted temp, so
  // the kernel policy must not either (also avoids the bwrap mask-clobber when
  // a throwaway HOME lives under /tmp).
  expect(policy.writableRoots).toEqual([canonicalizeRoot(memoryRoot)]);
  expect(policy.writableRoots).not.toContain(canonicalizeRoot("/tmp"));
  // Cross-agent reads denied: the whole agents tree is walled off...
  expect(policy.deniedRoots).toEqual([getDefaultAgentsTreeRoot()]);
  // ...with the agent's own dir carved back out READ-only (env survival +
  // reading own state) — writes stay denied there by restrictWrites.
  expect(policy.readonlyRoots).toEqual([canonicalizeRoot(agentDir)]);
});

test("memory-mode policy folds in extra writable roots but not temp dirs", () => {
  const agentDir = join(getDefaultAgentsTreeRoot(), "memmode-self");
  const memoryRoot = join(agentDir, "memory");
  const extra = makeTempDir();

  const policy = buildMemoryModeSandboxPolicy({
    memoryRoots: [memoryRoot],
    extraWritableRoots: [extra],
  });

  // Explicit extra roots are honored, but no temp dir is auto-granted.
  expect(policy.writableRoots).toContain(extra);
  expect(policy.writableRoots).not.toContain(canonicalizeRoot("/tmp"));
});

test("memory-mode policy (local backend): custom tree + restrictWrites:false deny-list", () => {
  // The local backend walls off `lc-local-backend/memfs` (not ~/.letta/agents)
  // and uses a deny-list (restrictWrites:false) so the in-process child can
  // still persist conversation/agent-state OUTSIDE the tree. Cross-agent
  // read-deny + self carve must still hold.
  const home = makeTempDir();
  const memfsTree = join(home, ".letta", "lc-local-backend", "memfs");
  const selfAgentDir = join(memfsTree, "agent-self");
  const memoryRoot = join(selfAgentDir, "memory");
  mkdirSync(memoryRoot, { recursive: true });

  const policy = buildMemoryModeSandboxPolicy({
    memoryRoots: [memoryRoot],
    agentsTreeRoot: memfsTree,
    restrictWrites: false,
  });

  // Deny-list: writes allowed by default (so conv/state outside memfs persist).
  expect(policy.restrictWrites).toBe(false);
  // The memfs tree is walled off (read+write) — NOT ~/.letta/agents.
  expect(policy.deniedRoots).toEqual([canonicalizeRoot(memfsTree)]);
  // Self agent dir carved readonly (env survival + own reads); self memory
  // carved writable (the subagent edits its own memory).
  expect(policy.readonlyRoots).toEqual([canonicalizeRoot(selfAgentDir)]);
  expect(policy.writableRoots).toEqual([canonicalizeRoot(memoryRoot)]);
});

test("memory-mode policy: restrictWrites and tree default to the API/cloud shape", () => {
  const agentDir = join(getDefaultAgentsTreeRoot(), "memmode-default");
  const memoryRoot = join(agentDir, "memory");

  const policy = buildMemoryModeSandboxPolicy({ memoryRoots: [memoryRoot] });

  // Omitting both params preserves the original API behavior exactly.
  expect(policy.restrictWrites).toBe(true);
  expect(policy.deniedRoots).toEqual([getDefaultAgentsTreeRoot()]);
});

test("cross-agent policy denies the agents tree and carves out self", () => {
  const home = makeTempDir();
  const agentsTree = join(home, ".letta", "agents");
  const selfDir = join(agentsTree, "self");
  mkdirSync(selfDir, { recursive: true });

  const policy = buildCrossAgentSandboxPolicy({
    selfRoots: [selfDir],
    agentsTreeRoot: agentsTree,
  });

  // Default-allow writes (the repo/home stay writable); only the agents tree
  // is walled off, with self carved back out.
  expect(policy.restrictWrites).toBe(false);
  expect(policy.deniedRoots).toEqual([agentsTree]);
  expect(policy.writableRoots).toEqual([selfDir]);
});

test("cross-agent policy defaults the agents tree to ~/.letta/agents", () => {
  const policy = buildCrossAgentSandboxPolicy({
    selfRoots: [canonicalizeRoot("/tmp")],
  });

  expect(policy.deniedRoots).toEqual([getDefaultAgentsTreeRoot()]);
});

test("deriveSelfAgentRoots collapses in-tree memory roots to the agent dir", () => {
  const tree = getDefaultAgentsTreeRoot();
  const agentDir = join(tree, "abc");
  const roots = deriveSelfAgentRoots(
    [join(agentDir, "memory"), join(agentDir, "memory-worktrees")],
    tree,
  );
  expect(roots).toEqual([canonicalizeRoot(agentDir)]);
});

test("deriveSelfAgentRoots keeps roots outside the tree as-is", () => {
  const tree = getDefaultAgentsTreeRoot();
  const outside = canonicalizeRoot("/tmp");
  expect(deriveSelfAgentRoots([outside], tree)).toEqual([outside]);
});
