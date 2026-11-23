import { expect, spyOn, test } from "bun:test";
import {
  executeTool,
  prepareToolExecutionContextForModel,
  releaseToolExecutionContext,
} from "./manager";
import { TOOL_DEFINITIONS } from "./tool-definitions";

test("WatchPR forwards the executor tool-call ID instead of a model-supplied ID", async () => {
  const run = spyOn(TOOL_DEFINITIONS.WatchPR, "impl").mockResolvedValue({
    content: [{ type: "text", text: "watching" }],
  });
  let contextId: string | undefined;
  try {
    const context = await prepareToolExecutionContextForModel(
      "anthropic/claude-sonnet-4",
      {
        clientToolAllowlist: ["WatchPR"],
        runtimeContext: { agentId: "agent-1", conversationId: "conv-1" },
      },
    );
    contextId = context.contextId;
    await executeTool(
      "WatchPR",
      {
        url: "https://github.com/example/repo/pull/1",
        toolCallId: "untrusted",
      },
      { toolCallId: "executor-call-1", toolContextId: context.contextId },
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      toolCallId: "executor-call-1",
    });
  } finally {
    if (contextId) releaseToolExecutionContext(contextId);
    run.mockRestore();
  }
});
