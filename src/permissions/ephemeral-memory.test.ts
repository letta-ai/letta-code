import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPostTurnMemorySync } from "@/reminders/memory-git-sync";
import {
  isConversationMemoryReadOnly,
  runWithRuntimeContext,
  setConversationMemoryReadOnly,
} from "@/runtime-context";
import { applyShellSandbox } from "@/tools/impl/shell-sandbox";
import { evaluateCrossAgentGuard } from "./cross-agent-guard";

// Exercise real path resolution and runtime scoping, without module mocks.
test("ephemeral memory policy is conversation-scoped and follows file symlinks", async () => {
  const root = mkdtempSync(join(tmpdir(), "ephemeral-memory-"));
  const memory = join(root, "memory");
  mkdirSync(memory);
  const alias = join(root, "alias");
  symlinkSync(memory, alias, process.platform === "win32" ? "junction" : "dir");
  const conversationId = "conv-readonly-paths";
  setConversationMemoryReadOnly(conversationId, true);
  const env = { MEMORY_DIR: memory, HOME: root };
  try {
    await runWithRuntimeContext(
      { agentId: "parent", conversationId },
      async () => {
        expect(isConversationMemoryReadOnly()).toBe(true);
        for (const toolName of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
          expect(
            evaluateCrossAgentGuard(
              toolName,
              { file_path: join(alias, "new.md") },
              root,
              {
                env,
                disableMemoryGuard: true,
              },
            )?.reason,
          ).toContain("cannot modify inherited memory");
        }
        expect(
          evaluateCrossAgentGuard(
            "ApplyPatch",
            {
              input: `*** Add File: ${join(alias, "new.md")}\n+no`,
            },
            root,
            { env },
          )?.reason,
        ).toContain("cannot modify inherited memory");
        expect(
          evaluateCrossAgentGuard("memory", { command: "insert" }, root, {
            env,
          })?.reason,
        ).toContain("cannot modify inherited memory");
        expect(
          evaluateCrossAgentGuard(
            "Read",
            { file_path: join(alias, "note.md") },
            root,
            { env },
          ),
        ).toBeNull();
        expect(
          evaluateCrossAgentGuard(
            "Write",
            { file_path: join(root, "code.ts") },
            root,
            { env },
          ),
        ).toBeNull();
        let syncCalls = 0;
        await runPostTurnMemorySync(
          { agentId: "parent" },
          {
            syncMemory: async () => {
              syncCalls++;
              throw new Error("must not sync");
            },
            syncAttachedRepositories: async () => {
              syncCalls++;
              throw new Error("must not sync");
            },
          },
        );
        expect(syncCalls).toBe(0);
      },
    );
    runWithRuntimeContext(
      { agentId: "parent", conversationId: "conv-ordinary" },
      () => {
        expect(isConversationMemoryReadOnly()).toBe(false);
        expect(
          evaluateCrossAgentGuard(
            "Write",
            { file_path: join(memory, "new.md") },
            root,
            { env },
          ),
        ).toBeNull();
      },
    );
  } finally {
    setConversationMemoryReadOnly(conversationId, false);
    rmSync(root, { recursive: true, force: true });
  }
});

test("an already-enabled shell sandbox gives forks read-only roots without changing the opt-in gate", () => {
  const conversationId = "conv-readonly-shell";
  setConversationMemoryReadOnly(conversationId, true);
  try {
    runWithRuntimeContext({ agentId: "parent", conversationId }, () => {
      const launcher = ["/bin/sh", "-c", "true"];
      const env = { MEMORY_DIR: join(tmpdir(), "fork-parent-memory") };
      const availability = {
        backend: "seatbelt" as const,
        reason: "policy test",
      };
      expect(
        applyShellSandbox(launcher, process.cwd(), env, availability).launcher,
      ).toBe(launcher);
      const wrapped = applyShellSandbox(
        launcher,
        process.cwd(),
        { ...env, LETTA_FS_SANDBOX: "1" },
        availability,
      );
      expect(
        wrapped.launcher.some((arg) => arg.startsWith("-DREADONLY_")),
      ).toBe(true);
      expect(
        wrapped.launcher.some((arg) => arg.startsWith("-DWRITABLE_")),
      ).toBe(false);
      expect(
        applyShellSandbox(
          launcher,
          process.cwd(),
          { ...env, LETTA_FS_SANDBOX: "1" },
          {
            backend: null,
            reason: "unavailable",
          },
        ).launcher,
      ).toBe(launcher);
    });
  } finally {
    setConversationMemoryReadOnly(conversationId, false);
  }
});
