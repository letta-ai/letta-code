import { describe, expect, test } from "bun:test";
import {
  annotateToolLoopReturn,
  canonicalizeToolCall,
  createToolLoopGuard,
  fingerprintToolCall,
  fingerprintToolResult,
  normalizeToolLoopArgs,
  type ToolLoopCall,
  type ToolLoopResult,
} from "@/agent/tool-loop-guard";

const call: ToolLoopCall = {
  toolName: "Bash",
  toolArgs: JSON.stringify({
    command: "git status",
    description: "Show working tree status",
  }),
  workingDirectory: "/workspace/project",
};

const success: ToolLoopResult = {
  status: "success",
  toolReturn: "file contents",
};

describe("tool call canonicalization", () => {
  test("parses args, sorts object keys, and ignores top-level description", () => {
    const reordered: ToolLoopCall = {
      toolName: "Bash",
      toolArgs: {
        description: "A different UI label",
        command: "git status",
      },
      workingDirectory: "/workspace/project",
    };

    expect(canonicalizeToolCall(call)).toBe(canonicalizeToolCall(reordered));
    expect(fingerprintToolCall(call)).toBe(fingerprintToolCall(reordered));
  });

  test("preserves array order and nested description fields", () => {
    expect(
      fingerprintToolCall({
        toolName: "Batch",
        toolArgs: { items: ["a", "b"] },
      }),
    ).not.toBe(
      fingerprintToolCall({
        toolName: "Batch",
        toolArgs: { items: ["b", "a"] },
      }),
    );

    expect(
      fingerprintToolCall({
        toolName: "Nested",
        toolArgs: { config: { description: "semantic-a" } },
      }),
    ).not.toBe(
      fingerprintToolCall({
        toolName: "Nested",
        toolArgs: { config: { description: "semantic-b" } },
      }),
    );
  });

  test("keeps description when it changes tool behavior", () => {
    expect(
      fingerprintToolCall({
        toolName: "Memory",
        toolArgs: { command: "update_description", description: "First" },
      }),
    ).not.toBe(
      fingerprintToolCall({
        toolName: "Memory",
        toolArgs: { command: "update_description", description: "Second" },
      }),
    );
  });

  test("includes tool name and working directory", () => {
    expect(fingerprintToolCall(call)).not.toBe(
      fingerprintToolCall({ ...call, toolName: "Write" }),
    );
    expect(fingerprintToolCall(call)).not.toBe(
      fingerprintToolCall({ ...call, workingDirectory: "/workspace/other" }),
    );
  });

  test("keeps malformed string args distinct and strips no nested fields", () => {
    expect(normalizeToolLoopArgs("Bash", "{not-json-a")).toBe("{not-json-a");
    expect(normalizeToolLoopArgs("Bash", "{not-json-b")).toBe("{not-json-b");
    expect(
      normalizeToolLoopArgs("Bash", {
        description: "display only",
        nested: { description: "keep me" },
      }),
    ).toEqual({ nested: { description: "keep me" } });
  });
});

describe("ToolLoopGuard", () => {
  test("warns from pair two and blocks preflight before execution five", () => {
    const guard = createToolLoopGuard();

    for (let execution = 1; execution <= 4; execution += 1) {
      const preflight = guard.preflight(call);
      expect(preflight.allowed).toBe(true);
      expect(preflight.consecutiveIdenticalPairs).toBe(execution - 1);

      const observation = guard.observeResult(call, success);
      expect(observation.consecutiveIdenticalPairs).toBe(execution);
      expect(observation.warning === null).toBe(execution === 1);
      expect(observation.willBlockNextIdenticalCall).toBe(execution === 4);
    }

    const fifth = guard.preflight(call);
    expect(fifth).toMatchObject({
      action: "block",
      allowed: false,
      blocked: true,
      consecutiveIdenticalPairs: 4,
    });
    expect(fifth.reason).toContain("4 consecutive identical");

    // Merely checking again cannot clear a blocked call.
    expect(guard.preflight(call).blocked).toBe(true);
  });

  test("requires the complete call/result pair to remain identical", () => {
    const guard = createToolLoopGuard();
    guard.observeResult(call, success);
    expect(guard.observeResult(call, success).consecutiveIdenticalPairs).toBe(
      2,
    );

    const changedStatus = guard.observeResult(call, {
      ...success,
      status: "error",
    });
    expect(changedStatus.consecutiveIdenticalPairs).toBe(1);
    expect(changedStatus.warning).toBeNull();

    const changedReturn = guard.observeResult(call, {
      ...success,
      toolReturn: "different contents",
    });
    expect(changedReturn.consecutiveIdenticalPairs).toBe(1);
  });

  test("a different call clears blocked state", () => {
    const guard = createToolLoopGuard();
    for (let execution = 0; execution < 4; execution += 1) {
      guard.observeResult(call, success);
    }
    expect(guard.preflight(call).blocked).toBe(true);

    const differentCall = {
      ...call,
      toolArgs: { command: "git status --short" },
    };
    expect(guard.preflight(differentCall).allowed).toBe(true);
    expect(guard.snapshot()).toMatchObject({
      consecutiveIdenticalPairs: 0,
      blocked: false,
    });

    // Returning to the original call is another change, so it starts fresh too.
    expect(guard.preflight(call).allowed).toBe(true);
    expect(guard.observeResult(call, success).consecutiveIdenticalPairs).toBe(
      1,
    );
  });

  test("reset clears warnings and a hard block", () => {
    const guard = createToolLoopGuard();
    for (let execution = 0; execution < 4; execution += 1) {
      guard.observeResult(call, success);
    }
    guard.reset();

    expect(guard.preflight(call).allowed).toBe(true);
    expect(guard.observeResult(call, success)).toMatchObject({
      consecutiveIdenticalPairs: 1,
      warning: null,
    });
  });

  test("annotates string returns only after fingerprinting the raw result", () => {
    const guard = createToolLoopGuard();
    const first = guard.observeResult(call, success);
    const second = guard.observeResult(call, success);

    expect(first.annotatedToolReturn).toBe("file contents");
    expect(second.annotatedToolReturn).toContain("file contents");
    expect(second.annotatedToolReturn).toContain(
      "same result 2 consecutive times",
    );
    expect(second.resultFingerprint).toBe(fingerprintToolResult(success));

    // The convenience annotation method does not mutate guard state.
    expect(guard.annotateToolReturn(success.toolReturn, second)).toBe(
      second.annotatedToolReturn,
    );
    expect(guard.snapshot().consecutiveIdenticalPairs).toBe(2);
    expect(guard.observeResult(call, success).consecutiveIdenticalPairs).toBe(
      3,
    );
  });

  test("appends a text part to multimodal returns without mutation", () => {
    const multimodal = [
      { type: "text", text: "look" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "abc" },
      },
    ] satisfies Exclude<ToolLoopResult["toolReturn"], string>;
    const guard = createToolLoopGuard();
    const result: ToolLoopResult = {
      status: "success",
      toolReturn: multimodal,
    };

    guard.observeResult(call, result);
    const second = guard.observeResult(call, result);

    expect(multimodal).toHaveLength(2);
    expect(second.annotatedToolReturn).toHaveLength(3);
    expect(second.annotatedToolReturn).toEqual([
      ...multimodal,
      { type: "text", text: second.warning ?? "" },
    ]);
    expect(second.resultFingerprint).toBe(fingerprintToolResult(result));
  });
});

describe("annotateToolLoopReturn", () => {
  test("is a no-op without a warning", () => {
    const parts = [{ type: "text" as const, text: "ok" }];
    expect(annotateToolLoopReturn("ok", null)).toBe("ok");
    expect(annotateToolLoopReturn(parts, null)).toBe(parts);
  });
});
