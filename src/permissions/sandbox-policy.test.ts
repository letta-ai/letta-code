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
  buildMemoryModeSandboxPolicy,
  canonicalizeRoot,
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

test("memory-mode policy restricts writes to memory roots + tmp, no read-deny", () => {
  const home = makeTempDir();
  const memoryRoot = join(home, ".letta", "agents", "self", "memory");
  mkdirSync(memoryRoot, { recursive: true });

  const policy = buildMemoryModeSandboxPolicy({
    memoryRoots: [memoryRoot],
    env: {},
  });

  expect(policy.restrictWrites).toBe(true);
  expect(policy.writableRoots).toContain(memoryRoot);
  // /tmp is canonicalized (e.g. /private/tmp on macOS) — match the real path.
  expect(policy.writableRoots).toContain(canonicalizeRoot("/tmp"));
  // No read-deny: a memory subagent's cwd is the memory dir, inside the agents
  // tree; denying reads there empties the child env under Seatbelt.
  expect(policy.deniedRoots).toEqual([]);
});

test("memory-mode policy folds in extra writable roots and TMPDIR", () => {
  const home = makeTempDir();
  const memoryRoot = join(home, ".letta", "agents", "self", "memory");
  mkdirSync(memoryRoot, { recursive: true });
  const extra = makeTempDir();

  const policy = buildMemoryModeSandboxPolicy({
    memoryRoots: [memoryRoot],
    extraWritableRoots: [extra],
    env: { TMPDIR: extra },
  });

  expect(policy.writableRoots).toContain(extra);
});
