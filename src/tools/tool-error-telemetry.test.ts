import { afterEach, describe, expect, mock, test } from "bun:test";
import { clearModTools, registerModTool } from "@/mods/tool-registry";
import { runWithRuntimeContext } from "@/runtime-context";
import { telemetry } from "@/telemetry";
import { executeTool } from "@/tools/manager";

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
      toolCallId: "call-2",
      toolName: "local_throw",
      toolType: "mod",
    });
    expect(JSON.stringify(payload)).not.toContain("secret");
  });
});
