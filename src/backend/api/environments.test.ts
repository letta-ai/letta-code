import { describe, expect, test } from "bun:test";
import { createAgentSandbox } from "@/backend/api/environments";
import type { apiRequest } from "@/backend/api/request";

describe("Cloud sandbox environment resolution", () => {
  test("sends conversationId in the create request body", async () => {
    const calls: Array<{
      method: string;
      path: string;
      body?: Record<string, unknown>;
    }> = [];
    const request = (async (
      method: string,
      path: string,
      body?: Record<string, unknown>,
    ) => {
      calls.push({ method, path, body });
      return {
        sandboxId: "sandbox-1",
        deviceId: "device-1",
        connectionName: "Cloud",
      };
    }) as typeof apiRequest;

    await createAgentSandbox("agent-1", { conversationId: "conv-1" }, request);

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/v1/agents/agent-1/sandboxes",
        body: { conversationId: "conv-1" },
      },
    ]);
  });

  test("keeps the virtual default conversation agent-scoped", async () => {
    const bodies: Array<Record<string, unknown> | undefined> = [];
    const request = (async (
      _method: string,
      _path: string,
      body?: Record<string, unknown>,
    ) => {
      bodies.push(body);
      return {
        sandboxId: "sandbox-1",
        deviceId: "device-1",
        connectionName: "Cloud",
      };
    }) as typeof apiRequest;

    await createAgentSandbox("agent-1", { conversationId: "default" }, request);

    expect(bodies).toEqual([{}]);
  });
});
