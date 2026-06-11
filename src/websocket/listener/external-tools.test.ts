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
});
