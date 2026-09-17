import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  enqueueMemoryWriterJob,
  isMemoryWriterSubagentType,
} from "@/agent/memory-writer-launcher";
import { runWithRuntimeContext } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";

const AGENT_ID = "agent-memory-writer";
let agentRoot: string;
let memoryDir: string;
let originalIsMemfsEnabled: typeof settingsManager.isMemfsEnabled;

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

function writerDeps(filename: string, contents: string, taskId: string) {
  return {
    spawnBackgroundSubagentTask: ({
      memoryScope,
      onComplete,
    }: {
      memoryScope?: { primaryRoot: string };
      onComplete?: (result: {
        success: boolean;
        agentId: string;
        report: string;
      }) => void;
    }) => {
      const root = memoryScope?.primaryRoot;
      if (!root) throw new Error("missing worktree");
      writeFileSync(join(root, filename), contents, "utf-8");
      void onComplete?.({
        success: true,
        agentId: "agent-writer",
        report: `STATUS: applied\n- ${filename}`,
      });
      return {
        taskId,
        outputFile: join(agentRoot, `${taskId}.txt`),
        subagentId: `sub-${taskId}`,
      };
    },
    recompileAgentSystemPrompt: async () => "",
    syncPendingMemoryCommitsAfterTurn: async () =>
      ({
        status: "skipped",
        summary: "test",
        memoryDir,
        localOnly: true,
      }) as never,
    resolveAuthor: async () => ({
      agentId: AGENT_ID,
      authorName: "Parent",
      authorEmail: `${AGENT_ID}@letta.com`,
    }),
  };
}

beforeEach(() => {
  agentRoot = join(homedir(), ".letta", "agents", AGENT_ID);
  memoryDir = join(agentRoot, "memory");
  rmSync(agentRoot, { recursive: true, force: true });
  mkdirSync(memoryDir, { recursive: true });
  git(memoryDir, ["init", "-b", "main"]);
  git(memoryDir, ["config", "user.email", "test@test.com"]);
  git(memoryDir, ["config", "user.name", "test"]);
  writeFileSync(
    join(memoryDir, "persona.md"),
    "---\ndescription: Persona\n---\nbase\n",
    "utf-8",
  );
  git(memoryDir, ["add", "persona.md"]);
  git(memoryDir, ["commit", "-m", "init"]);

  originalIsMemfsEnabled = settingsManager.isMemfsEnabled;
  (
    settingsManager as unknown as {
      isMemfsEnabled: (id: string) => boolean;
    }
  ).isMemfsEnabled = (id: string) => id === AGENT_ID;
});

afterEach(() => {
  (
    settingsManager as unknown as {
      isMemfsEnabled: typeof originalIsMemfsEnabled;
    }
  ).isMemfsEnabled = originalIsMemfsEnabled;
  rmSync(agentRoot, { recursive: true, force: true });
});

describe("memory-writer launcher", () => {
  test("aliases the legacy memory subagent type", () => {
    expect(isMemoryWriterSubagentType("memory")).toBe(true);
    expect(isMemoryWriterSubagentType("memory-writer")).toBe(true);
    expect(isMemoryWriterSubagentType("reflection")).toBe(false);
  });

  test("queues immediately and applies a drafted file in the background", async () => {
    const queued = await runWithRuntimeContext(
      { agentId: AGENT_ID, conversationId: "conv-1" },
      () =>
        enqueueMemoryWriterJob(
          {
            agentId: AGENT_ID,
            conversationId: "conv-1",
            instruction: "Remember that the user prefers bun",
            source: "remember",
          },
          writerDeps(
            "human.md",
            "---\ndescription: Human\n---\nprefers bun\n",
            "task-1",
          ),
        ),
    );

    expect(queued.status).toBe("queued");
    expect(queued.message).toContain("queued");

    const applied = await enqueueMemoryWriterJob(
      {
        agentId: AGENT_ID,
        conversationId: "conv-1",
        instruction: "Remember that the user prefers bun",
        source: "remember",
        wait: true,
      },
      writerDeps(
        "notes.md",
        "---\ndescription: Notes\n---\nqueued wait\n",
        "task-2",
      ),
    );

    expect(applied.status).toBe("applied");
    expect(existsSync(join(memoryDir, "notes.md"))).toBe(true);
    expect(readFileSync(join(memoryDir, "notes.md"), "utf-8")).toContain(
      "queued wait",
    );
    expect(existsSync(join(memoryDir, "human.md"))).toBe(true);
  });

  test("rejects agents without memfs", async () => {
    await expect(
      enqueueMemoryWriterJob({
        agentId: "agent-no-memfs",
        conversationId: "conv-1",
        instruction: "Remember this",
        source: "remember",
      }),
    ).rejects.toThrow(/memory filesystem is not enabled/);
  });
});
