import { afterEach, describe, expect, test } from "bun:test";
import type WebSocket from "ws";
import {
  clearExternalTools,
  executeTool,
  prepareToolExecutionContextForModel,
} from "@/tools/manager";
import type { ExternalToolCallRequestMessage } from "@/types/protocol_v2";
import { getOrCreateScopedRuntime } from "@/websocket/listener/conversation-runtime";
import {
  handleExternalToolCallResponseCommand,
  installExternalToolBridge,
  registerRuntimeExternalTools,
  rejectPendingExternalToolCalls,
  rejectPendingExternalToolCallsForConnection,
} from "@/websocket/listener/external-tools";
import { createRuntime } from "@/websocket/listener/lifecycle";
import { consumeQueuedTurn } from "@/websocket/listener/queue";
import type { ListenerRuntime } from "@/websocket/listener/types";

function createMockRuntime(): {
  runtime: ListenerRuntime;
  sent: ExternalToolCallRequestMessage[];
} {
  const sent: ExternalToolCallRequestMessage[] = [];
  const runtime = {
    intentionallyClosed: false,
    pendingExternalToolCalls: new Map(),
    connections: new Map(),
  } as unknown as ListenerRuntime;
  const writer = {
    readyState: 1,
    send(data: string) {
      const request = JSON.parse(data) as ExternalToolCallRequestMessage;
      sent.push(request);
      queueMicrotask(() => {
        handleExternalToolCallResponseCommand(runtime, "client-1", {
          type: "external_tool_call_response",
          request_id: request.request_id,
          result: {
            content: [{ type: "text", text: `lookup:${request.input.id}` }],
          },
        });
      });
    },
  } as unknown as WebSocket;
  runtime.connections.set("client-1", {
    id: "client-1",
    writer,
  } as never);
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
      "client-1",
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
        runtimeContext: {
          connectionId: "client-1",
          agentId: "agent-1",
          conversationId: "conv-1",
        },
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

  test("delegates a trusted cron scope without crossing runtime or ownership boundaries", async () => {
    const { runtime } = createMockRuntime();
    installExternalToolBridge(runtime);
    const scope = { agent_id: "agent-1", conversation_id: "conv-1" };
    const gatewayTool = {
      name: "MessageChannel",
      description: "Gateway-owned channel tool",
      parameters: { type: "object", properties: {} },
    };
    const registerGateway = () =>
      registerRuntimeExternalTools(runtime, "client-1", scope, [
        { scope_id: "channel-gateway", tools: [gatewayTool] },
      ]);
    const prepare = (conversationId: string, trusted: boolean) =>
      prepareToolExecutionContextForModel("anthropic/claude-sonnet-4", {
        externalToolScopeIds: ["channel-gateway"],
        runtimeContext: {
          connectionId: "scheduler-client",
          allowExternalToolScopeDelegation: trusted,
          agentId: "agent-1",
          conversationId,
        },
      });
    const hasGatewayTool = (prepared: Awaited<ReturnType<typeof prepare>>) =>
      prepared.clientTools.some((tool) => tool.name === "MessageChannel");

    registerGateway();
    expect(hasGatewayTool(await prepare("conv-1", false))).toBe(false);
    const delegated = await prepare("conv-1", true);
    expect(hasGatewayTool(delegated)).toBe(true);
    expect(hasGatewayTool(await prepare("conv-2", true))).toBe(false);

    const result = await executeTool(
      "MessageChannel",
      { id: "scheduled" },
      { toolContextId: delegated.contextId, toolCallId: "call-cron" },
    );
    expect(result.toolReturn).toBe("lookup:scheduled");

    rejectPendingExternalToolCallsForConnection(
      runtime,
      "client-1",
      "gateway disconnected",
    );
    expect(hasGatewayTool(await prepare("conv-1", true))).toBe(false);

    registerGateway();
    const directTool = {
      ...gatewayTool,
      description: "Directly owned channel tool",
    };
    registerRuntimeExternalTools(runtime, "scheduler-client", scope, [
      { tools: [directTool] },
    ]);
    expect(
      (await prepare("conv-1", true)).clientTools.find(
        (tool) => tool.name === "MessageChannel",
      )?.description,
    ).toBe("Directly owned channel tool");
  });

  test("keeps same tool name and scope id isolated across runtimes", async () => {
    const { runtime } = createMockRuntime();
    registerRuntimeExternalTools(
      runtime,
      "client-1",
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
      "client-1",
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
        runtimeContext: {
          connectionId: "client-1",
          agentId: "agent-1",
          conversationId: "conv-a",
        },
      },
    );
    const preparedB = await prepareToolExecutionContextForModel(
      "anthropic/claude-sonnet-4",
      {
        clientToolAllowlist: ["lookup_ticket"],
        externalToolScopeIds: ["search"],
        runtimeContext: {
          connectionId: "client-1",
          agentId: "agent-1",
          conversationId: "conv-b",
        },
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

  test("keeps same runtime tool registrations isolated by connection", async () => {
    const { runtime } = createMockRuntime();
    const runtimeScope = {
      agent_id: "agent-1",
      conversation_id: "conv-1",
    };
    const registerForConnection = (connectionId: string, description: string) =>
      registerRuntimeExternalTools(runtime, connectionId, runtimeScope, [
        {
          scope_id: "search",
          tools: [
            {
              name: "lookup_ticket",
              description,
              parameters: { type: "object", properties: {} },
            },
          ],
        },
      ]);
    registerForConnection("client-a", "Lookup from client A");
    registerForConnection("client-b", "Lookup from client B");

    const preparedA = await prepareToolExecutionContextForModel(
      "anthropic/claude-sonnet-4",
      {
        clientToolAllowlist: ["lookup_ticket"],
        externalToolScopeIds: ["search"],
        runtimeContext: {
          connectionId: "client-a",
          agentId: "agent-1",
          conversationId: "conv-1",
        },
      },
    );
    const preparedB = await prepareToolExecutionContextForModel(
      "anthropic/claude-sonnet-4",
      {
        clientToolAllowlist: ["lookup_ticket"],
        externalToolScopeIds: ["search"],
        runtimeContext: {
          connectionId: "client-b",
          agentId: "agent-1",
          conversationId: "conv-1",
        },
      },
    );

    expect(preparedA.clientTools).toEqual([
      expect.objectContaining({ description: "Lookup from client A" }),
    ]);
    expect(preparedB.clientTools).toEqual([
      expect.objectContaining({ description: "Lookup from client B" }),
    ]);

    rejectPendingExternalToolCallsForConnection(
      runtime,
      "client-b",
      "disconnected",
    );
    const preparedAfterDisconnect = await prepareToolExecutionContextForModel(
      "anthropic/claude-sonnet-4",
      {
        clientToolAllowlist: ["lookup_ticket"],
        externalToolScopeIds: ["search"],
        runtimeContext: {
          connectionId: "client-a",
          agentId: "agent-1",
          conversationId: "conv-1",
        },
      },
    );
    expect(preparedAfterDisconnect.clientTools).toEqual([
      expect.objectContaining({ description: "Lookup from client A" }),
    ]);
  });

  test("repeated runtime_start registration replaces tools for that runtime", async () => {
    const { runtime } = createMockRuntime();
    const runtimeScope = { agent_id: "agent-1", conversation_id: "conv-1" };
    registerRuntimeExternalTools(runtime, "client-1", runtimeScope, [
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
    registerRuntimeExternalTools(runtime, "client-1", runtimeScope, [
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
        runtimeContext: {
          connectionId: "client-1",
          agentId: "agent-1",
          conversationId: "conv-1",
        },
      },
    );

    expect(prepared.clientTools.map((tool) => tool.name)).toEqual(["new_tool"]);
  });

  test("runtime-owned external tools unregister when listener runtime stops", async () => {
    const { runtime } = createMockRuntime();
    registerRuntimeExternalTools(
      runtime,
      "client-1",
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
        runtimeContext: {
          connectionId: "client-1",
          agentId: "agent-1",
          conversationId: "conv-1",
        },
      },
    );

    expect(prepared.clientTools).toEqual([]);
  });

  test("synthesizes trusted gateway delegation only for cron turns", () => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    runtime.queueRuntime.enqueue({
      kind: "cron_prompt",
      source: "cron",
      text: "scheduled prompt",
      cronTaskId: "cron-1",
      agentId: "agent-1",
      conversationId: "conv-1",
    } as Omit<
      import("@/queue/queue-runtime").CronPromptQueueItem,
      "id" | "enqueuedAt"
    >);

    const consumed = consumeQueuedTurn(runtime);

    expect(consumed?.queuedTurn.connectionId).toBeUndefined();
    expect(consumed?.queuedTurn.externalToolScopeIds).toEqual([
      "channel-gateway",
    ]);
    expect(consumed?.queuedTurn.allowExternalToolScopeDelegation).toBe(true);
  });
});
