import { afterEach, describe, expect, test } from "bun:test";
import type WebSocket from "ws";
import {
  clearExternalTools,
  executeTool,
  prepareToolExecutionContextForModel,
} from "@/tools/manager";
import type { ExternalToolCallRequestMessage } from "@/types/protocol_v2";
import {
  handleExternalToolCallResponseCommand,
  installExternalToolBridge,
  registerRuntimeExternalTools,
  rejectPendingExternalToolCalls,
} from "@/websocket/listener/external-tools";
import type { ListenerRuntime } from "@/websocket/listener/types";

function createMockRuntime(): {
  runtime: ListenerRuntime;
  sent: ExternalToolCallRequestMessage[];
} {
  const sent: ExternalToolCallRequestMessage[] = [];
  const runtime = {
    intentionallyClosed: false,
    pendingExternalToolCalls: new Map(),
  } as unknown as ListenerRuntime;
  runtime.socket = {
    readyState: 1,
    send(data: string) {
      const request = JSON.parse(data) as ExternalToolCallRequestMessage;
      sent.push(request);
      queueMicrotask(() => {
        handleExternalToolCallResponseCommand(runtime, {
          type: "external_tool_call_response",
          request_id: request.request_id,
          result: {
            content: [{ type: "text", text: `lookup:${request.input.id}` }],
          },
        });
      });
    },
  } as unknown as WebSocket;
  return { runtime, sent };
}

describe("app-server runtime_start external tool bridge", () => {
  afterEach(() => {
    clearExternalTools();
  });

  test("registers runtime-scoped tools and executes calls over the control socket", async () => {
    const { runtime, sent } = createMockRuntime();
    installExternalToolBridge(runtime);
    registerRuntimeExternalTools(
      runtime,
      { agent_id: "agent-1", conversation_id: "conv-1" },
      [
        {
          scope_id: "scope-1",
          tools: [
            {
              name: "RemoteLookup",
              description: "Lookup a remote resource",
              parameters: {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
              },
            },
          ],
        },
      ],
    );

    const prepared = await prepareToolExecutionContextForModel(
      "anthropic/claude-sonnet-4",
      {
        clientToolAllowlist: ["RemoteLookup"],
        externalToolScopeIds: ["scope-1"],
        runtimeContext: { agentId: "agent-1", conversationId: "conv-1" },
      },
    );

    const result = await executeTool(
      "RemoteLookup",
      { id: "ABC-123" },
      { toolContextId: prepared.contextId, toolCallId: "call-1" },
    );

    expect(result.status).toBe("success");
    expect(result.toolReturn).toBe("lookup:ABC-123");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "external_tool_call_request",
      runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
      scope_id: "scope-1",
      tool_call_id: "call-1",
      tool_name: "RemoteLookup",
      input: { id: "ABC-123" },
    });
  });

  test("keeps same tool name and scope id isolated across runtimes", async () => {
    const { runtime } = createMockRuntime();
    registerRuntimeExternalTools(
      runtime,
      { agent_id: "agent-1", conversation_id: "conv-a" },
      [
        {
          scope_id: "search",
          tools: [
            {
              name: "lookup_ticket",
              description: "Lookup ticket for conversation A",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
      ],
    );
    registerRuntimeExternalTools(
      runtime,
      { agent_id: "agent-1", conversation_id: "conv-b" },
      [
        {
          scope_id: "search",
          tools: [
            {
              name: "lookup_ticket",
              description: "Lookup ticket for conversation B",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
      ],
    );

    const preparedA = await prepareToolExecutionContextForModel(
      "anthropic/claude-sonnet-4",
      {
        clientToolAllowlist: ["lookup_ticket"],
        externalToolScopeIds: ["search"],
        runtimeContext: { agentId: "agent-1", conversationId: "conv-a" },
      },
    );
    const preparedB = await prepareToolExecutionContextForModel(
      "anthropic/claude-sonnet-4",
      {
        clientToolAllowlist: ["lookup_ticket"],
        externalToolScopeIds: ["search"],
        runtimeContext: { agentId: "agent-1", conversationId: "conv-b" },
      },
    );

    expect(preparedA.clientTools).toEqual([
      expect.objectContaining({
        name: "lookup_ticket",
        description: "Lookup ticket for conversation A",
      }),
    ]);
    expect(preparedB.clientTools).toEqual([
      expect.objectContaining({
        name: "lookup_ticket",
        description: "Lookup ticket for conversation B",
      }),
    ]);
  });

  test("accepts an external tool result only from its controller connection", async () => {
    const runtime = {
      intentionallyClosed: false,
      pendingExternalToolCalls: new Map(),
    } as unknown as ListenerRuntime;
    const sent: ExternalToolCallRequestMessage[] = [];
    const controller = {
      readyState: 1,
      send(data: string) {
        sent.push(JSON.parse(data) as ExternalToolCallRequestMessage);
      },
    } as unknown as WebSocket;
    const otherConnection = { readyState: 1 } as unknown as WebSocket;
    installExternalToolBridge(runtime);
    registerRuntimeExternalTools(
      runtime,
      { agent_id: "agent-1", conversation_id: "conv-1" },
      [
        {
          tools: [
            {
              name: "connection_owned_tool",
              description: "Connection owned tool",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
      ],
      controller,
    );
    const prepared = await prepareToolExecutionContextForModel(
      "anthropic/claude-sonnet-4",
      {
        clientToolAllowlist: ["connection_owned_tool"],
        runtimeContext: { agentId: "agent-1", conversationId: "conv-1" },
      },
    );

    const resultPromise = executeTool(
      "connection_owned_tool",
      {},
      { toolContextId: prepared.contextId, toolCallId: "call-1" },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = sent[0];
    if (!request) throw new Error("expected external tool request");
    const response = {
      type: "external_tool_call_response" as const,
      request_id: request.request_id,
      result: { content: [{ type: "text" as const, text: "owned" }] },
    };

    expect(
      handleExternalToolCallResponseCommand(runtime, response, otherConnection),
    ).toBe(false);
    expect(runtime.pendingExternalToolCalls?.has(request.request_id)).toBe(
      true,
    );
    expect(
      handleExternalToolCallResponseCommand(runtime, response, controller),
    ).toBe(true);
    expect((await resultPromise).toolReturn).toBe("owned");
  });

  test("repeated runtime_start registration replaces tools for that runtime", async () => {
    const { runtime } = createMockRuntime();
    const runtimeScope = { agent_id: "agent-1", conversation_id: "conv-1" };
    registerRuntimeExternalTools(runtime, runtimeScope, [
      {
        tools: [
          {
            name: "old_tool",
            description: "Old tool",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
    ]);
    registerRuntimeExternalTools(runtime, runtimeScope, [
      {
        tools: [
          {
            name: "new_tool",
            description: "New tool",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
    ]);

    const prepared = await prepareToolExecutionContextForModel(
      "anthropic/claude-sonnet-4",
      {
        clientToolAllowlist: ["old_tool", "new_tool"],
        runtimeContext: { agentId: "agent-1", conversationId: "conv-1" },
      },
    );

    expect(prepared.clientTools.map((tool) => tool.name)).toEqual(["new_tool"]);
  });

  test("runtime-owned external tools unregister when listener runtime stops", async () => {
    const { runtime } = createMockRuntime();
    registerRuntimeExternalTools(
      runtime,
      { agent_id: "agent-1", conversation_id: "conv-1" },
      [
        {
          tools: [
            {
              name: "runtime_only",
              description: "Runtime owned tool",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
      ],
    );

    rejectPendingExternalToolCalls(runtime, "stop");

    const prepared = await prepareToolExecutionContextForModel(
      "anthropic/claude-sonnet-4",
      {
        clientToolAllowlist: ["runtime_only"],
        runtimeContext: { agentId: "agent-1", conversationId: "conv-1" },
      },
    );

    expect(prepared.clientTools).toEqual([]);
  });
});
