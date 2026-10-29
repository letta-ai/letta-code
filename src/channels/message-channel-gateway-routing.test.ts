import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import {
  clearExternalTools,
  executeTool,
  registerExternalTools,
  setExternalToolExecutor,
} from "@/tools/manager";
import { prepareToolExecutionContextForScope } from "@/tools/toolset";

/**
 * A cloud channel gateway (for example the Microsoft Teams broker) registers
 * MessageChannel as a listener external tool with a composite
 * registrationKey, a runtime owner, and the registering connection id —
 * exactly what toExternalToolDefinition produces for a runtimeStart
 * external_tools group without a scope_id.
 *
 * These tests pin how a model-facing "MessageChannel" call resolves in the
 * two execution shapes a listener can see:
 *   1. a listener-driven turn, whose tool context is captured by
 *      prepareToolExecutionContextForScope with the turn's runtime scope; and
 *   2. a fallback execution with no captured context, which consults the
 *      global external-tools registry directly.
 */
describe("gateway-registered MessageChannel external tool routing", () => {
  const agentId = "agent-gateway-routing";
  const conversationId = "conv-gateway-routing";
  const connectionId = "conn-gateway-routing";
  const registrationKey = JSON.stringify([
    "runtime",
    connectionId,
    agentId,
    conversationId,
    null,
    "MessageChannel",
  ]);

  let externalCalls: Array<{ name: string; input: Record<string, unknown> }>;

  beforeEach(() => {
    __testSetBackend(new FakeHeadlessBackend());
    externalCalls = [];
    registerExternalTools([
      {
        name: "MessageChannel",
        description: "Cloud channel gateway message tool",
        parameters: { type: "object", properties: {}, required: [] },
        registrationKey,
        connectionId,
        runtime: { agentId, conversationId },
      },
    ]);
    setExternalToolExecutor(async (_toolCallId, toolName, input) => {
      externalCalls.push({ name: toolName, input });
      return {
        content: [{ type: "text", text: "gateway sent" }],
        isError: false,
      };
    });
  });

  afterEach(() => {
    clearExternalTools();
  });

  test("listener-driven turn context routes the call to the gateway tool", async () => {
    const prepared = await prepareToolExecutionContextForScope({
      connectionId,
      agentId,
      conversationId,
      workingDirectory: "/tmp",
    });

    const result = await executeTool(
      "MessageChannel",
      { channel: "microsoftteams", recipient: "chat-1", content: "hi" },
      { toolContextId: prepared.preparedToolContext.contextId },
    );

    expect(externalCalls).toHaveLength(1);
    expect(externalCalls[0]?.name).toBe("MessageChannel");
    expect(result.status).toBe("success");
  });

  test("contextless fallback execution cannot find the gateway tool", async () => {
    const result = await executeTool("MessageChannel", {
      channel: "microsoftteams",
      recipient: "chat-1",
      content: "hi",
    });

    // The global registry is keyed by the composite registrationKey, so a
    // model-facing name lookup misses and execution falls through to the local
    // tool (or "Tool not found" when MessageChannel is not loaded).
    expect(externalCalls).toHaveLength(0);
    expect(result.status).toBe("error");
  });
});
