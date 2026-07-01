import { afterEach, describe, expect, mock, test } from "bun:test";
import { clearModTools, registerModTool } from "@/mods/tool-registry";
import { runWithRuntimeContext } from "@/runtime-context";
import { telemetry } from "@/telemetry";
import {
  clearCapturedToolExecutionContexts,
  executeTool,
  getExecutionContextById,
  prepareToolExecutionContextForSpecificTools,
} from "@/tools/manager";

const originalTrackToolCallError = telemetry.trackToolCallError;
const originalTrackToolUsage = telemetry.trackToolUsage;

type ToolCallErrorPayload = Parameters<typeof telemetry.trackToolCallError>[0];

type ModRun = Parameters<typeof registerModTool>[0]["run"];

type MockWithCalls = {
  mock: { calls: unknown };
};

function getFirstToolCallErrorPayload(
  trackToolCallError: MockWithCalls,
): ToolCallErrorPayload {
  const calls = trackToolCallError.mock.calls as Array<[ToolCallErrorPayload]>;
  const payload = calls[0]?.[0];
  if (!payload) {
    throw new Error("Expected tool call error telemetry payload");
  }
  return payload;
}

function registerLocalModTool(name: string, run: ModRun): void {
  registerModTool({
    name,
    description: "Local test mod tool",
    parameters: {
      type: "object",
      properties: { message: { type: "string" } },
    },
    owner: {
      id: `global:/tmp/${name}.ts`,
      path: `/tmp/${name}.ts`,
      scope: "global",
      generation: 1,
    },
    path: `/tmp/${name}.ts`,
    approvalPolicy: "auto",
    requiresApproval: false,
    parallelSafe: true,
    activationSignal: new AbortController().signal,
    run,
  });
}

describe("tool error telemetry", () => {
  afterEach(() => {
    telemetry.trackToolCallError = originalTrackToolCallError;
    telemetry.trackToolUsage = originalTrackToolUsage;
    clearCapturedToolExecutionContexts();
    clearModTools();
  });

  test("traces returned tool errors without leaking output or arguments", async () => {
    const trackToolCallError = mock(() => {});
    telemetry.trackToolCallError =
      trackToolCallError as unknown as typeof telemetry.trackToolCallError;
    telemetry.trackToolUsage = mock(
      () => {},
    ) as unknown as typeof telemetry.trackToolUsage;

    registerLocalModTool("local_fail", () => ({
      status: "error",
      content: "secret output from the tool",
      stderr: ["secret stderr from the tool"],
    }));

    const result = await runWithRuntimeContext(
      {
        agentId: "agent-1",
        conversationId: "conv-1",
        stepId: "step-1",
        workingDirectory: process.cwd(),
      },
      () =>
        executeTool(
          "local_fail",
          { message: "secret argument from the model" },
          { toolCallId: "call-1" },
        ),
    );

    expect(result.status).toBe("error");
    expect(trackToolCallError).toHaveBeenCalledTimes(1);
    const payload = getFirstToolCallErrorPayload(trackToolCallError);
    expect(payload).toEqual({
      agentId: "agent-1",
      conversationId: "conv-1",
      errorType: "tool_error",
      reason: "tool_returned_error",
      stepId: "step-1",
      toolCallId: "call-1",
      toolName: "local_fail",
      toolType: "mod",
    });
    expect(JSON.stringify(payload)).not.toContain("secret");
  });

  test("traces thrown tool errors without leaking exception messages", async () => {
    const trackToolCallError = mock(() => {});
    telemetry.trackToolCallError =
      trackToolCallError as unknown as typeof telemetry.trackToolCallError;
    telemetry.trackToolUsage = mock(
      () => {},
    ) as unknown as typeof telemetry.trackToolUsage;

    registerLocalModTool("local_throw", () => {
      throw new TypeError("secret exception message from tool internals");
    });

    const result = await runWithRuntimeContext(
      {
        agentId: "agent-1",
        conversationId: "conv-1",
        stepId: "step-2",
        workingDirectory: process.cwd(),
      },
      () =>
        executeTool(
          "local_throw",
          { message: "secret argument from the model" },
          { toolCallId: "call-2" },
        ),
    );

    expect(result.status).toBe("error");
    expect(trackToolCallError).toHaveBeenCalledTimes(1);
    const payload = getFirstToolCallErrorPayload(trackToolCallError);
    expect(payload).toEqual({
      agentId: "agent-1",
      conversationId: "conv-1",
      errorType: "TypeError",
      reason: "tool_exception",
      stepId: "step-2",
      toolCallId: "call-2",
      toolName: "local_throw",
      toolType: "mod",
    });
    expect(JSON.stringify(payload)).not.toContain("secret");
  });

  test("traces unresolved tools with runtime step ids", async () => {
    const trackToolCallError = mock(() => {});
    telemetry.trackToolCallError =
      trackToolCallError as unknown as typeof telemetry.trackToolCallError;
    telemetry.trackToolUsage = mock(
      () => {},
    ) as unknown as typeof telemetry.trackToolUsage;

    const result = await runWithRuntimeContext(
      {
        agentId: "agent-1",
        conversationId: "conv-1",
        stepId: "step-3",
        workingDirectory: process.cwd(),
      },
      () => executeTool("missing_tool", {}, { toolCallId: "call-3" }),
    );

    expect(result.status).toBe("error");
    expect(trackToolCallError).toHaveBeenCalledTimes(1);
    const payload = getFirstToolCallErrorPayload(trackToolCallError);
    expect(payload).toEqual({
      agentId: "agent-1",
      conversationId: "conv-1",
      errorType: "tool_not_found",
      reason: "tool_not_found",
      stepId: "step-3",
      toolCallId: "call-3",
      toolName: "missing_tool",
      toolType: "unknown",
    });
  });

  test("traces missing built-in registry entries with runtime step ids", async () => {
    const trackToolCallError = mock(() => {});
    telemetry.trackToolCallError =
      trackToolCallError as unknown as typeof telemetry.trackToolCallError;
    telemetry.trackToolUsage = mock(
      () => {},
    ) as unknown as typeof telemetry.trackToolUsage;

    const prepared = await prepareToolExecutionContextForSpecificTools(
      ["Read"],
      {
        runtimeContext: {
          agentId: "agent-1",
          conversationId: "conv-1",
          stepId: "step-4",
          workingDirectory: process.cwd(),
        },
        workingDirectory: process.cwd(),
      },
    );
    const context = getExecutionContextById(prepared.contextId);
    if (!context) {
      throw new Error("Expected prepared tool execution context");
    }
    context.toolRegistry.set("Read", undefined as never);

    const result = await executeTool(
      "Read",
      {},
      { toolCallId: "call-4", toolContextId: prepared.contextId },
    );

    expect(result.status).toBe("error");
    expect(trackToolCallError).toHaveBeenCalledTimes(1);
    const payload = getFirstToolCallErrorPayload(trackToolCallError);
    expect(payload).toEqual({
      agentId: "agent-1",
      conversationId: "conv-1",
      errorType: "tool_not_found",
      reason: "tool_not_found",
      stepId: "step-4",
      toolCallId: "call-4",
      toolName: "Read",
      toolType: "built_in",
    });
  });
});
