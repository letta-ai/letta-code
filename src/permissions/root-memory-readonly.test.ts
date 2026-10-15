import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithRuntimeContext } from "@/runtime-context";
import {
  buildRootMemoryReadonlyPolicy,
  evaluateRootMemoryReadonlyGuard,
  resolveReadonlyMemoryRoot,
} from "./root-memory-readonly";
import { canonicalizeRoot } from "./sandbox-policy";

test("root protection is scoped to the coordinator conversation, not memory workers", () => {
  const env = {
    LETTA_READONLY_ROOT_MEMORY_CONVERSATION: "conv-coordinator",
    MEMORY_DIR: canonicalizeRoot(join(tmpdir(), "coordinator-memory")),
  };
  expect(
    runWithRuntimeContext({ conversationId: "conv-coordinator" }, () =>
      resolveReadonlyMemoryRoot(env),
    ),
  ).toBe(env.MEMORY_DIR);
  expect(
    runWithRuntimeContext({ conversationId: "conv-memory-worker" }, () =>
      resolveReadonlyMemoryRoot(env),
    ),
  ).toBeNull();
  expect(resolveReadonlyMemoryRoot({})).toBeNull();
});

test("root files and both rename endpoints are protected; nested files and reads remain allowed", () => {
  const root = canonicalizeRoot(
    mkdtempSync(join(tmpdir(), "root-memory-readonly-")),
  );
  mkdirSync(join(root, "reference"));
  writeFileSync(join(root, "MEMORY.md"), "index");
  symlinkSync(join(root, "MEMORY.md"), join(root, "reference", "alias.md"));
  try {
    for (const path of [
      "MEMORY.md",
      "new.md",
      "profile.png",
      "reference/alias.md",
      "new-directory/note.md",
    ]) {
      expect(
        evaluateRootMemoryReadonlyGuard(
          "Write",
          { file_path: path },
          root,
          root,
        ),
      ).not.toBeNull();
    }
    expect(
      evaluateRootMemoryReadonlyGuard(
        "Read",
        { file_path: "MEMORY.md" },
        root,
        root,
      ),
    ).toBeNull();
    expect(
      evaluateRootMemoryReadonlyGuard(
        "Write",
        { file_path: "reference/new.md" },
        root,
        root,
      ),
    ).toBeNull();
    for (const [source, target] of [
      ["MEMORY.md", "reference/moved.md"],
      ["reference/note.md", "new.md"],
    ]) {
      expect(
        evaluateRootMemoryReadonlyGuard(
          "ApplyPatch",
          {
            input: `*** Begin Patch\n*** Update File: ${source}\n*** Move to: ${target}\n@@\n-old\n+new\n*** End Patch`,
          },
          root,
          root,
        ),
      ).not.toBeNull();
    }
    const policy = buildRootMemoryReadonlyPolicy(root);
    expect(policy.readonlyRoots).toEqual([root]);
    expect(policy.writableRoots).toEqual([join(root, "reference")]);
    expect(policy.restrictWrites).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
