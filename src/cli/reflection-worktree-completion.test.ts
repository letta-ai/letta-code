import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createReflectionMemoryWorktree,
  type ReflectionMemoryWorktree,
} from "@/agent/memory-worktree";
import { finalizeReflectionMemoryWorktreeLaunch } from "@/cli/helpers/reflection-launcher";
import { telemetry } from "@/telemetry";

let tempDir: string;
let memoryDir: string;
const originalDoNotTrack = process.env.DO_NOT_TRACK;
const originalLettaCodeTelem = process.env.LETTA_CODE_TELEM;
const originalTelemetryDrain = telemetry.drain;
const telemetryState = telemetry as unknown as {
  events: Array<{
    type: string;
    data: Record<string, unknown>;
  }>;
};

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: GIT_ENV,
    encoding: "utf-8",
  });
}

function writeParentMemoryFile(relativePath: string, content: string): void {
  writeFileSync(join(memoryDir, relativePath), content, "utf-8");
}

async function finalizeLaunch(
  worktree: ReflectionMemoryWorktree,
  subagentSuccess: boolean,
) {
  return await finalizeReflectionMemoryWorktreeLaunch({
    worktree,
    subagentSuccess,
    subagentError: subagentSuccess ? undefined : "subagent failed",
    agentId: "agent-test",
    conversationId: "conv-test",
    subagentAgentId: "agent-reflection-test",
    model: "reflection-model",
    telemetryContext: { triggerSource: "manual" },
    recompileByConversation: new Map(),
    recompileQueuedByConversation: new Set(),
  });
}

beforeEach(() => {
  telemetry.cleanup();
  telemetryState.events = [];
  telemetry.drain = mock(async () => {});
  delete process.env.DO_NOT_TRACK;
  tempDir = mkdtempSync(join(tmpdir(), "reflection-completion-"));
  memoryDir = join(tempDir, "agent", "memory");
  git(tempDir, ["init", "-b", "main", memoryDir]);
  git(memoryDir, ["config", "core.autocrlf", "false"]);
  git(memoryDir, ["config", "core.eol", "lf"]);
  writeParentMemoryFile("persona.md", "base\n");
  git(memoryDir, ["add", "persona.md"]);
  git(memoryDir, ["commit", "-m", "init"]);
});

afterEach(() => {
  telemetry.drain = originalTelemetryDrain;
  if (originalDoNotTrack === undefined) {
    delete process.env.DO_NOT_TRACK;
  } else {
    process.env.DO_NOT_TRACK = originalDoNotTrack;
  }
  if (originalLettaCodeTelem === undefined) {
    delete process.env.LETTA_CODE_TELEM;
  } else {
    process.env.LETTA_CODE_TELEM = originalLettaCodeTelem;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe("reflection worktree completion messaging", () => {
  test("parent dirty cleans up and leaves the transcript retryable", async () => {
    const worktree = await createReflectionMemoryWorktree({
      parentMemoryDir: memoryDir,
    });
    writeFileSync(
      join(worktree.worktreeDir, "reflection.md"),
      "dream\n",
      "utf-8",
    );
    git(worktree.worktreeDir, ["add", "reflection.md"]);
    git(worktree.worktreeDir, ["commit", "-m", "reflection"]);
    writeParentMemoryFile("parent-dirty.md", "dirty\n");

    const result = await finalizeLaunch(worktree, true);

    expect(result.integration.status).toBe("parent_dirty");
    expect(result.integration.summary).toContain(
      "parent memory repo had uncommitted changes",
    );
    expect(result.completionSuccess).toBe(false);
    expect(result.completionMessage).toBe(
      "Tried to reflect, but parent memory had uncommitted changes; will retry later.",
    );

    const event = telemetryState.events.find(
      (entry) => entry.type === "reflection_worktree_cleanup",
    );
    expect(telemetryState.events).toHaveLength(1);
    expect(event?.data).toMatchObject({
      outcome: "parent_dirty",
      integration_status: "parent_dirty",
      trigger_source: "manual",
      subagent_id: "agent-reflection-test",
      conversation_id: "conv-test",
      reflection_worktree_id: worktree.id,
      commit_count: 1,
      model: "reflection-model",
    });
  });

  test("parent merge conflict cleans up and leaves the transcript retryable", async () => {
    const worktree = await createReflectionMemoryWorktree({
      parentMemoryDir: memoryDir,
    });
    writeFileSync(
      join(worktree.worktreeDir, "persona.md"),
      "reflection\n",
      "utf-8",
    );
    git(worktree.worktreeDir, ["add", "persona.md"]);
    git(worktree.worktreeDir, ["commit", "-m", "reflection"]);
    writeParentMemoryFile("persona.md", "parent\n");
    git(memoryDir, ["add", "persona.md"]);
    git(memoryDir, ["commit", "-m", "parent"]);

    const result = await finalizeLaunch(worktree, true);

    expect(result.integration.status).toBe("merge_conflict");
    expect(result.integration.summary).toContain("conflicted");
    expect(result.completionSuccess).toBe(false);
    expect(result.completionMessage).toBe(
      "Tried to reflect, but memory updates conflicted with newer changes; will retry later.",
    );

    const event = telemetryState.events.find(
      (entry) => entry.type === "reflection_worktree_cleanup",
    );
    expect(telemetryState.events).toHaveLength(1);
    expect(event?.data).toMatchObject({
      outcome: "merge_conflict",
      integration_status: "merge_conflict",
      trigger_source: "manual",
      subagent_id: "agent-reflection-test",
      conversation_id: "conv-test",
      reflection_worktree_id: worktree.id,
      commit_count: 1,
      model: "reflection-model",
    });
  });

  test("dirty reflection worktree retries transcript with dirty message", async () => {
    const worktree = await createReflectionMemoryWorktree({
      parentMemoryDir: memoryDir,
    });
    writeFileSync(join(worktree.worktreeDir, "scratch.md"), "dirty\n", "utf-8");

    const result = await finalizeLaunch(worktree, true);

    expect(result.integration.status).toBe("dirty_uncommitted");
    expect(result.integration.summary).toContain("uncommitted changes");
    expect(result.completionSuccess).toBe(false);
    expect(result.completionMessage).toBe(
      "Tried to reflect, but memory changes were not committed cleanly; will retry later.",
    );
    expect(telemetryState.events).toHaveLength(1);
    expect(telemetryState.events[0]?.data).toMatchObject({
      outcome: "reflection_worktree_dirty",
      integration_status: "dirty_uncommitted",
      reflection_worktree_id: worktree.id,
      commit_count: 0,
    });
  });

  test("failed reflection retries transcript with failed update message", async () => {
    const worktree = await createReflectionMemoryWorktree({
      parentMemoryDir: memoryDir,
    });

    const result = await finalizeLaunch(worktree, false);

    expect(result.integration.status).toBe("failed");
    expect(result.integration.summary).toContain(
      "subagent did not complete successfully",
    );
    expect(result.completionSuccess).toBe(false);
    expect(result.completionMessage).toBe(
      "Tried to reflect, but memory updates were not completed cleanly; will retry later.",
    );
    expect(telemetryState.events).toHaveLength(1);
    expect(telemetryState.events[0]?.data).toMatchObject({
      outcome: "subagent_failed",
      integration_status: "failed",
      reflection_worktree_id: worktree.id,
      commit_count: 0,
    });
  });
});
