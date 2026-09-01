import { describe, expect, test } from "bun:test";
import type { Backend } from "@/backend";
import type { EnvironmentConnection } from "@/backend/api/environments";
import { INTERRUPTED_BY_USER } from "@/constants";
import {
  executeRemoteSubagent,
  resolveRemoteEnvironmentRouting,
} from "./remote-environment";

function environmentFixture(
  overrides: Partial<EnvironmentConnection> = {},
): EnvironmentConnection {
  return {
    connectionId: "conn-1",
    connectionName: "office-mac",
    deviceId: "device-1",
    status: "online",
    metadata: { environmentMessageProtocol: "v2-input" },
    ...overrides,
  } as EnvironmentConnection;
}

describe("resolveRemoteEnvironmentRouting", () => {
  test("resolves a named environment through the environment resolver", async () => {
    const events: string[] = [];
    const routing = await resolveRemoteEnvironmentRouting(
      "office-mac",
      { agentId: "agent-1", conversationId: "conv-1" },
      {
        resolveEnvironment: async (selector) => {
          events.push(`env:${selector}`);
          return { connectionId: "conn-1", environment: environmentFixture() };
        },
        resolveSandbox: async () => {
          throw new Error("sandbox resolver should not be called");
        },
      },
    );
    expect(events).toEqual(["env:office-mac"]);
    expect(routing.connectionId).toBe("conn-1");
  });

  test("routes cloud selectors to the sandbox resolver", async () => {
    const events: string[] = [];
    await resolveRemoteEnvironmentRouting(
      "cloud",
      { agentId: "agent-1", conversationId: "conv-1" },
      {
        resolveEnvironment: async () => {
          throw new Error("environment resolver should not be called");
        },
        resolveSandbox: async (agentId, options) => {
          events.push(`sandbox:${agentId}:${options?.conversationId}`);
          return { connectionId: "conn-sb", environment: environmentFixture() };
        },
      },
    );
    expect(events).toEqual(["sandbox:agent-1:conv-1"]);
  });

  test("rejects environments without v2-input support", async () => {
    await expect(
      resolveRemoteEnvironmentRouting(
        "office-mac",
        { agentId: "agent-1" },
        {
          resolveEnvironment: async () => ({
            connectionId: "conn-1",
            environment: environmentFixture({ metadata: {} }),
          }),
        },
      ),
    ).rejects.toThrow(/does not advertise environment-routed/);
  });
});

describe("executeRemoteSubagent", () => {
  const routing = {
    connectionId: "conn-1",
    environment: environmentFixture(),
  };

  test("sends the prompt and returns the assistant reply as the report", async () => {
    const events: string[] = [];
    let sentOtid: string | undefined;
    const result = await executeRemoteSubagent(
      {
        routing,
        agentId: "agent-1",
        conversationId: "conv-1",
        prompt: "do the thing",
        subagentId: "sub-1",
      },
      {
        updateSubagentState: (id, updates) => {
          events.push(
            `update:${id}:${updates.agentId}:${updates.conversationId}`,
          );
        },
        sendMessage: async (connectionId, body) => {
          const message = body.messages[0];
          if (
            message &&
            "otid" in message &&
            typeof message.otid === "string"
          ) {
            sentOtid = message.otid;
          }
          events.push(
            `send:${connectionId}:${body.agentId}:${body.conversationId}`,
          );
          return { success: true, message: "ok" };
        },
        getBackendImpl: () => ({}) as Backend,
        waitForAssistantMessage: async (params) => {
          events.push(`wait:${params.otid === sentOtid}`);
          return { text: "remote done", stopReason: "end_turn" };
        },
      },
    );
    expect(events).toEqual([
      "update:sub-1:agent-1:conv-1",
      "send:conn-1:agent-1:conv-1",
      "wait:true",
    ]);
    expect(result.success).toBe(true);
    expect(result.report).toBe("remote done");
    expect(result.agentId).toBe("agent-1");
    expect(result.conversationId).toBe("conv-1");
  });

  test("marks error stop reasons as failures", async () => {
    const result = await executeRemoteSubagent(
      {
        routing,
        agentId: "agent-1",
        conversationId: "conv-1",
        prompt: "do the thing",
        subagentId: "sub-1",
      },
      {
        updateSubagentState: () => {},
        sendMessage: async () => ({ success: true, message: "ok" }),
        getBackendImpl: () => ({}) as Backend,
        waitForAssistantMessage: async () => ({
          text: "partial",
          stopReason: "error",
        }),
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("error");
  });

  test("returns interruption when the signal aborts mid-wait", async () => {
    const abortController = new AbortController();
    const result = await executeRemoteSubagent(
      {
        routing,
        agentId: "agent-1",
        conversationId: "conv-1",
        prompt: "do the thing",
        subagentId: "sub-1",
        signal: abortController.signal,
      },
      {
        updateSubagentState: () => {},
        sendMessage: async () => ({ success: true, message: "ok" }),
        getBackendImpl: () => ({}) as Backend,
        waitForAssistantMessage: async () => {
          abortController.abort();
          throw new Error("Aborted while waiting");
        },
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe(INTERRUPTED_BY_USER);
  });

  test("returns failure with the error message when dispatch throws", async () => {
    const result = await executeRemoteSubagent(
      {
        routing,
        agentId: "agent-1",
        conversationId: "conv-1",
        prompt: "do the thing",
        subagentId: "sub-1",
      },
      {
        updateSubagentState: () => {},
        sendMessage: async () => {
          throw new Error("connection refused");
        },
        getBackendImpl: () => ({}) as Backend,
        waitForAssistantMessage: async () => {
          throw new Error("should not wait");
        },
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("connection refused");
  });
});
