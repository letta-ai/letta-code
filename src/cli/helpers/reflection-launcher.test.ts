import { describe, expect, mock, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getReflectionLaunchSkippedMessage,
  launchReflectionSubagent,
  type ReflectionLaunchOptions,
  shouldRunQueuedReflectionLaunch,
} from "@/cli/helpers/reflection-launcher";
import {
  REFLECTION_STATE_SCHEMA_VERSION,
  type ReflectionTranscriptState,
} from "@/cli/helpers/reflection-transcript";

function queuedLaunchOptions(
  overrides: Partial<ReflectionLaunchOptions> = {},
): ReflectionLaunchOptions {
  return {
    agentId: "agent-1",
    conversationId: "conv-1",
    memfsEnabled: true,
    triggerSource: "step-count",
    reflectionSettings: { trigger: "step-count", stepCount: 25 },
    description: "Reflect on recent conversations",
    recompileByConversation: new Map(),
    recompileQueuedByConversation: new Set(),
    ...overrides,
  };
}

function transcriptState(
  stepsSinceLastSuccessfulReflection: number,
): ReflectionTranscriptState {
  return {
    schema_version: REFLECTION_STATE_SCHEMA_VERSION,
    total_completed_steps: stepsSinceLastSuccessfulReflection,
    reflected_completed_steps: 0,
    steps_since_last_successful_reflection: stepsSinceLastSuccessfulReflection,
  };
}

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

describe("shouldRunQueuedReflectionLaunch", () => {
  test("skips queued step-count launches when the threshold is no longer met", async () => {
    const getTranscriptState = mock(async () => transcriptState(1));

    const shouldRun = await shouldRunQueuedReflectionLaunch(
      queuedLaunchOptions(),
      { getTranscriptState },
    );

    expect(shouldRun).toBe(false);
    expect(getTranscriptState).toHaveBeenCalledWith("agent-1", "conv-1");
  });

  test("runs queued step-count launches when the threshold is still met", async () => {
    const getTranscriptState = mock(async () => transcriptState(25));

    const shouldRun = await shouldRunQueuedReflectionLaunch(
      queuedLaunchOptions(),
      { getTranscriptState },
    );

    expect(shouldRun).toBe(true);
  });

  test("does not re-check non-step-count queued launches", async () => {
    const getTranscriptState = mock(async () => transcriptState(0));

    const shouldRun = await shouldRunQueuedReflectionLaunch(
      queuedLaunchOptions({ triggerSource: "compaction-event" }),
      { getTranscriptState },
    );

    expect(shouldRun).toBe(true);
    expect(getTranscriptState).not.toHaveBeenCalled();
  });
});

describe("launchReflectionSubagent", () => {
  test("skips client-side reflection after server cutover", async () => {
    const isCutover = mock(async () => true);

    const result = await launchReflectionSubagent(queuedLaunchOptions(), {
      isCutover,
    });

    expect(result).toEqual({ launched: false, reason: "cutover" });
    expect(isCutover).toHaveBeenCalledWith("agent-1");
  });

  test("skips before payload and worktree creation when parent memory is dirty", async () => {
    const originalLocalBackend = process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
    const originalLocalBackendDir = process.env.LETTA_LOCAL_BACKEND_DIR;
    const storageDir = mkdtempSync(join(tmpdir(), "reflection-preflight-"));
    const agentId = "agent-parent-dirty";
    const memoryDir = join(storageDir, "memfs", agentId, "memory");

    try {
      process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL = "1";
      process.env.LETTA_LOCAL_BACKEND_DIR = storageDir;
      mkdirSync(memoryDir, { recursive: true });
      git(storageDir, ["init", "-b", "main", memoryDir]);
      writeFileSync(join(memoryDir, "persona.md"), "base\n", "utf-8");
      git(memoryDir, ["add", "persona.md"]);
      git(memoryDir, ["commit", "-m", "init"]);
      writeFileSync(join(memoryDir, "dirty.md"), "dirty\n", "utf-8");

      const result = await launchReflectionSubagent(
        queuedLaunchOptions({ agentId }),
        { isCutover: async () => false },
      );

      expect(result).toEqual({ launched: false, reason: "parent_dirty" });
      expect(
        existsSync(join(storageDir, "memfs", agentId, "memory-worktrees")),
      ).toBe(false);
    } finally {
      if (originalLocalBackend === undefined) {
        delete process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
      } else {
        process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL = originalLocalBackend;
      }
      if (originalLocalBackendDir === undefined) {
        delete process.env.LETTA_LOCAL_BACKEND_DIR;
      } else {
        process.env.LETTA_LOCAL_BACKEND_DIR = originalLocalBackendDir;
      }
      rmSync(storageDir, { recursive: true, force: true });
    }
  });
});

describe("getReflectionLaunchSkippedMessage", () => {
  test("formats parent-dirty and listener-specific skipped reasons", () => {
    expect(getReflectionLaunchSkippedMessage("cutover")).toContain(
      "managed by Letta Cloud",
    );
    expect(getReflectionLaunchSkippedMessage("parent_dirty")).toContain(
      "uncommitted changes",
    );
    expect(getReflectionLaunchSkippedMessage("no_payload", "listener")).toBe(
      "No new transcript content to reflect on for this conversation.",
    );
  });
});
