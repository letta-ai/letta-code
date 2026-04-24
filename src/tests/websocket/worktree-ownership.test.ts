import { describe, expect, test } from "bun:test";
import path from "node:path";
import { runWithRuntimeContext } from "../../runtime-context";
import { __listenClientTestUtils } from "../../websocket/listen-client";
import {
  getConversationRuntime,
  setActiveRuntime,
} from "../../websocket/listener/runtime";
import {
  __worktreeOwnershipTestUtils,
  clearExpectedWorktreePath,
  hasExpectedWorktreePath,
  noteExpectedWorktreeForLauncher,
} from "../../websocket/listener/worktree-ownership";

describe("worktree ownership tracking", () => {
  test("tracks the expected worktree path for the active conversation", () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    void __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conv-1",
    );
    setActiveRuntime(listener);

    try {
      runWithRuntimeContext(
        {
          agentId: "agent-1",
          conversationId: "conv-1",
          workingDirectory: "/repo",
        },
        () => {
          noteExpectedWorktreeForLauncher(
            [
              "/bin/bash",
              "-lc",
              'git worktree add -b fix/foo ".letta/worktrees/fix-foo" main',
            ],
            "/repo",
          );
        },
      );

      const runtime = getConversationRuntime(listener, "agent-1", "conv-1");
      expect(runtime?.expectedWorktreePath).toBe(
        path.resolve("/repo", ".letta/worktrees/fix-foo"),
      );
    } finally {
      setActiveRuntime(null);
    }
  });

  test("only accepts the exact expected worktree path and clears it after use", () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtime = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conv-1",
    );

    runtime.expectedWorktreePath = path.resolve(
      "/repo",
      ".letta/worktrees/fix-foo",
    );

    expect(
      hasExpectedWorktreePath(
        runtime,
        path.resolve("/repo", ".letta/worktrees/other"),
      ),
    ).toBe(false);
    expect(
      hasExpectedWorktreePath(
        runtime,
        path.resolve("/repo", ".letta/worktrees/fix-foo"),
      ),
    ).toBe(true);

    clearExpectedWorktreePath(runtime);
    expect(runtime.expectedWorktreePath).toBeNull();
  });

  test("parses direct git launchers and git -C commands", () => {
    expect(
      __worktreeOwnershipTestUtils.resolveGitWorktreeAddTargetPathFromLauncher(
        [
          "git",
          "-C",
          "packages/app",
          "worktree",
          "add",
          "-b",
          "fix/bar",
          ".letta/worktrees/fix-bar",
          "main",
        ],
        "/repo",
      ),
    ).toBe(path.resolve("/repo/packages/app", ".letta/worktrees/fix-bar"));
  });

  test("parses env-prefixed git worktree commands", () => {
    expect(
      __worktreeOwnershipTestUtils.resolveGitWorktreeAddTargetPath(
        "FOO=1 env -i BAR=2 git worktree add -b fix/foo ../outside main",
        "/repo",
      ),
    ).toBe(path.resolve("/repo", "../outside"));

    expect(
      __worktreeOwnershipTestUtils.resolveGitWorktreeAddTargetPathFromLauncher(
        [
          "env",
          "-i",
          "FOO=1",
          "git",
          "worktree",
          "add",
          "-b",
          "fix/foo",
          ".letta/worktrees/fix-foo",
          "main",
        ],
        "/repo",
      ),
    ).toBe(path.resolve("/repo", ".letta/worktrees/fix-foo"));
  });
});
