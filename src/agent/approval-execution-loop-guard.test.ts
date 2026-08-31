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
    const chunks: string[] = [];

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const [result] = await executeApprovalBatch(
        [repeatedDecision(`call-${attempt}`)],
        (chunk) => chunks.push(chunk.tool_return),
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

    expect(chunks).toHaveLength(4);
    expect(chunks.at(-1)).toContain(
      "next identical call will be stopped for explicit user approval",
    );
    expect(
      guard.preflight({
        toolName: "Bash",
        toolArgs: { command: "git status" },
        workingDirectory: "/workspace/project",
      }),
    ).toMatchObject({ allowed: false, consecutiveIdenticalPairs: 4 });
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
