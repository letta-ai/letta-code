import { afterEach, describe, expect, test } from "bun:test";
import { clearExternalTools, executeExternalTool } from "@/tools/manager";
import {
  handleExternalToolCallResponseCommand,
  handleExternalToolsRegisterCommand,
  installExternalToolBridge,
} from "@/websocket/listener/external-tools";
import type { ListenerRuntime } from "@/websocket/listener/types";

class FakeSocket {
  readyState = 1;
  readonly sent: unknown[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
}

function createRuntime(socket: FakeSocket): ListenerRuntime {
  return {
    socket,
    intentionallyClosed: false,
    pendingExternalToolCalls: new Map(),
  } as unknown as ListenerRuntime;
}

describe("app-server external tool bridge", () => {
  afterEach(() => {
    clearExternalTools();
  });

  test("registers scoped tools and acknowledges registration", () => {
    const socket = new FakeSocket();
    const runtime = createRuntime(socket);
    handleExternalToolsRegisterCommand(
      runtime,
      {
        type: "external_tools_register",
        request_id: "register-1",
        scope_id: "council-1",
        runtime: { agent_id: "agent-1", conversation_id: "default" },
        tools: [
          {
            name: "council-write",
            description: "Write council opinion",
            parameters: { type: "object", properties: {}, required: [] },
          },
        ],
      },
      socket as never,
    );

    expect(socket.sent).toEqual([
      {
        type: "external_tools_register_response",
        request_id: "register-1",
        success: true,
        scope_id: "council-1",
        tool_names: ["council-write"],
      },
    ]);
  });

  test("executes external tools through request/response frames", async () => {
    const socket = new FakeSocket();
    const runtime = createRuntime(socket);
    installExternalToolBridge(runtime);

    const resultPromise = executeExternalTool(
      "tool-call-1",
      "council-write",
      { side: "thesis" },
      undefined,
      {
        tool: {
          name: "council-write",
          description: "Write council opinion",
          parameters: { type: "object", properties: {}, required: [] },
          scopeId: "council-1",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
        },
      },
    );

    expect(socket.sent).toEqual([
      {
        type: "external_tool_call_request",
        request_id: expect.stringMatching(/^external-tool-/),
        runtime: { agent_id: "agent-1", conversation_id: "default" },
        scope_id: "council-1",
        tool_call_id: "tool-call-1",
        tool_name: "council-write",
        input: { side: "thesis" },
      },
    ]);

    const request = socket.sent[0] as { request_id: string };
    expect(
      handleExternalToolCallResponseCommand(runtime, {
        type: "external_tool_call_response",
        request_id: request.request_id,
        result: { content: [{ type: "text", text: "ok" }] },
      }),
    ).toBe(true);

    await expect(resultPromise).resolves.toEqual({
      toolReturn: "ok",
      status: "success",
    });
  });
});
