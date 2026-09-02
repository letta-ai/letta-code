import { describe, expect, test } from "bun:test";
import {
  type ApprovalDecision,
  executeApprovalBatch,
} from "@/agent/approval-execution";
import { createToolLoopGuard } from "@/agent/tool-loop-guard";

function repeatedDecision(toolCallId: string): ApprovalDecision {
  return {
    type: "approve",
    approval: {
      toolCallId,
      toolName: "Bash",
      toolArgs: JSON.stringify({
        command: "git status",
        description: `Attempt ${toolCallId}`,
      }),
    },
    precomputedResult: {
      status: "success",
      toolReturn: "fatal: not a git repository",
    },
  };
}

describe("executeApprovalBatch tool loop guard", () => {
  test("preserves a consecutive pair streak across approval batches", async () => {
    const guard = createToolLoopGuard();

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const [result] = await executeApprovalBatch(
        [repeatedDecision(`call-${attempt}`)],
        undefined,
        {
          toolLoopGuard: guard,
          workingDirectory: "/workspace/project",
        },
      );

      expect(result?.type).toBe("tool");
      if (result?.type !== "tool") throw new Error("expected tool result");
      expect(result.tool_call_id).toBe(`call-${attempt}`);
      if (typeof result.tool_return !== "string") {
        throw new Error("expected text tool result");
      }
      expect(result.tool_return).toContain("fatal: not a git repository");
      expect(result.tool_return.includes("Tool loop warning")).toBe(
        attempt >= 2,
      );
    }

    expect(
      guard.preflight({
        toolName: "Bash",
        toolArgs: { command: "git status" },
        workingDirectory: "/workspace/project",
      }),
    ).toMatchObject({ allowed: false, consecutiveIdenticalPairs: 4 });
  });

  test("does not emit a second terminal chunk when adding a warning", async () => {
    const guard = createToolLoopGuard();
    const chunks: string[] = [];
    const missingTool = (toolCallId: string): ApprovalDecision => ({
      type: "approve",
      approval: {
        toolCallId,
        toolName: "missing_loop_guard_test_tool",
        toolArgs: "{}",
      },
    });

    await executeApprovalBatch(
      [missingTool("missing-1")],
      (chunk) => chunks.push(chunk.tool_return),
      { toolLoopGuard: guard, workingDirectory: "/workspace/project" },
    );
    const [second] = await executeApprovalBatch(
      [missingTool("missing-2")],
      (chunk) => chunks.push(chunk.tool_return),
      { toolLoopGuard: guard, workingDirectory: "/workspace/project" },
    );

    expect(chunks).toHaveLength(2);
    expect(chunks[1]).not.toContain("Tool loop warning");
    expect(second?.type).toBe("tool");
    if (second?.type !== "tool" || typeof second.tool_return !== "string") {
      throw new Error("expected text tool result");
    }
    expect(second.tool_return).toContain("Tool loop warning");
  });

  test("stops the fifth identical call inside one approval batch", async () => {
    const guard = createToolLoopGuard();
    const decisions = Array.from({ length: 6 }, (_, index) =>
      repeatedDecision(`batch-call-${index + 1}`),
    );

    const results = await executeApprovalBatch(decisions, undefined, {
      toolLoopGuard: guard,
      workingDirectory: "/workspace/project",
    });

    expect(results).toHaveLength(6);
    for (const result of results.slice(0, 4)) {
      expect(result.type).toBe("tool");
      if (result.type !== "tool" || typeof result.tool_return !== "string") {
        throw new Error("expected text tool result");
      }
      expect(result.tool_return).toContain("fatal: not a git repository");
    }
    for (const result of results.slice(4)) {
      expect(result.type).toBe("tool");
      if (result.type !== "tool" || typeof result.tool_return !== "string") {
        throw new Error("expected text tool result");
      }
      expect(result.status).toBe("error");
      expect(result.tool_return).toContain(
        "stopped after 4 consecutive identical",
      );
    }
  });

  test("does not carry warning annotations into result fingerprints", async () => {
    const guard = createToolLoopGuard();

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await executeApprovalBatch(
        [repeatedDecision(`call-${attempt}`)],
        undefined,
        {
          toolLoopGuard: guard,
          workingDirectory: "/workspace/project",
        },
      );
    }

    expect(guard.snapshot()).toMatchObject({
      consecutiveIdenticalPairs: 3,
      blocked: false,
    });
  });
});
