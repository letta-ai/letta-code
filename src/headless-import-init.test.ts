import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ImportInitState,
  importInitState,
  importInitVerify,
  importInitWaitForWorkflows,
} from "@/headless-import-init";
import {
  __resetWorkflowExecutionsForTests,
  finishWorkflowExecution,
  registerWorkflowExecution,
} from "@/tools/workflow/execution-registry";

const roots: string[] = [];
afterEach(() => {
  __resetWorkflowExecutionsForTests();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture(sessionIds = ["a", "b"]): ImportInitState {
  const root = mkdtempSync(join(tmpdir(), "import-init-wait-"));
  roots.push(root);
  mkdirSync(join(root, "export"));
  writeFileSync(
    join(root, "export", "manifest.json"),
    JSON.stringify({
      sessions: sessionIds.map((sessionId) => ({ sessionId })),
    }),
  );
  const memoryDir = join(root, "memory");
  mkdirSync(memoryDir);
  execFileSync("git", ["init", "-q"], { cwd: memoryDir });
  return {
    manifestDir: join(root, "export"),
    expectedSessions: sessionIds.length,
    memoryDir,
    handled: new Set(),
    workflowRuns: [],
    followUps: 0,
    startedAt: Date.now(),
  };
}

function register(state: ImportInitState, taskId = "workflow_1") {
  const executionDir = join(state.manifestDir, taskId);
  mkdirSync(executionDir);
  registerWorkflowExecution({
    taskId,
    executionDir,
    outputFile: join(executionDir, "output.txt"),
    meta: { name: "import-history", description: "Import history" },
  });
  return executionDir;
}

describe("opt-in headless import init Workflow lifecycle", () => {
  test("rejects invalid imported agent scope and missing Workflow", async () => {
    expect(() =>
      importInitState(
        JSON.stringify({
          agentId: "another",
          manifestDir: "/tmp",
          expectedSessions: 1,
        }),
        "agent-me",
      ),
    ).toThrow("scope");
    await expect(importInitWaitForWorkflows(fixture())).rejects.toThrow(
      "No dynamic Workflow",
    );
  });

  test("waits for terminal Workflow and requires synthesis, full coverage, committed memory", async () => {
    const state = fixture();
    const executionDir = register(state);
    const waiting = importInitWaitForWorkflows(state);
    finishWorkflowExecution("workflow_1", { status: "completed" });
    const followUp = await waiting;
    expect(followUp).toContain("journal.jsonl");
    expect(state.followUps).toBe(1);
    expect(await importInitWaitForWorkflows(state)).toBeNull();
    expect(() => importInitVerify(state)).toThrow("Missing Workflow journal");
    writeFileSync(
      join(executionDir, "journal.jsonl"),
      `${["a", "b"]
        .map((id) =>
          JSON.stringify({
            outcome: {
              failed: false,
              conversationId: `conv-${id}`,
              value: { sessionsRead: [id] },
            },
          }),
        )
        .join("\n")}\n`,
    );
    expect(() => importInitVerify(state)).toThrow(
      "no new committed initialization",
    );
    writeFileSync(join(state.memoryDir, "MEMORY.md"), "# Initialized\n");
    execFileSync("git", ["add", "MEMORY.md"], { cwd: state.memoryDir });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-qm",
        "init",
      ],
      { cwd: state.memoryDir },
    );
    expect(() => importInitVerify(state)).not.toThrow();
    writeFileSync(join(state.memoryDir, "extra.md"), "uncommitted");
    expect(() => importInitVerify(state)).toThrow("uncommitted");
    expect(readFileSync(join(executionDir, "journal.jsonl"), "utf8")).toContain(
      "sessionsRead",
    );
  });

  test("rejects failed Workflow and unaccounted sessions", async () => {
    const state = fixture();
    register(state);
    finishWorkflowExecution("workflow_1", {
      status: "failed",
      error: "worker error",
    });
    await expect(importInitWaitForWorkflows(state)).rejects.toThrow("failed");
    __resetWorkflowExecutionsForTests();
    const dir = register(state, "workflow_2");
    writeFileSync(
      join(dir, "journal.jsonl"),
      `${JSON.stringify({
        outcome: {
          failed: false,
          conversationId: "conv-a",
          value: { sessionsRead: ["a"] },
        },
      })}\n`,
    );
    finishWorkflowExecution("workflow_2", { status: "completed" });
    await importInitWaitForWorkflows(state);
    expect(() => importInitVerify(state)).toThrow("1/2 sessions");
  });
});
