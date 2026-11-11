import { afterEach, beforeAll, expect, mock, spyOn, test } from "bun:test";
import type { AppServerClient } from "@/app-server-client";
import { settingsManager } from "@/settings-manager";
import {
  sendRemoteExternalCodingAgentMessage,
  stopRemoteExternalCodingAgent,
} from "./remote-external-coding-agent";

beforeAll(() => settingsManager.initialize());
const scope = { agentId: "agent-parent", conversationId: "conv-parent" };
const originalApiKey = process.env.LETTA_API_KEY;
const originalBaseUrl = process.env.LETTA_BASE_URL;
afterEach(() => {
  mock.restore();
  if (originalApiKey === undefined) delete process.env.LETTA_API_KEY;
  else process.env.LETTA_API_KEY = originalApiKey;
  if (originalBaseUrl === undefined) delete process.env.LETTA_BASE_URL;
  else process.env.LETTA_BASE_URL = originalBaseUrl;
});
function mockApiFetch(handler: (request: Request) => Promise<Response>) {
  spyOn(globalThis, "fetch").mockImplementation(((
    input: string | URL | Request,
    init?: RequestInit,
  ) =>
    handler(
      input instanceof Request
        ? new Request(input, init)
        : new Request(input.toString(), init),
    )) as typeof fetch);
}
function environment() {
  return {
    id: "env-1",
    connectionName: "cloud",
    organizationId: "org-1",
    podId: null,
    connectedAt: null,
    lastSeenAt: 1,
    firstSeenAt: 1,
    metadata: { subagent_message: true },
  };
}

for (const action of ["send", "stop"] as const) {
  test(`${action} wakes the caller's idle cloud sandbox using its original conversation`, async () => {
    process.env.LETTA_API_KEY = "test-key";
    process.env.LETTA_BASE_URL = "https://api.example.test";
    const conversationId = "conv-11111111-1111-4111-8111-111111111111";
    const deviceId = `sandbox-${scope.agentId}-${conversationId}-linux-vm`;
    let awake = false;
    const requests: string[] = [];
    mockApiFetch(async (request) => {
      const path = new URL(request.url).pathname;
      requests.push(`${request.method} ${path}`);
      if (request.method === "POST") {
        expect(path).toBe(`/v1/agents/${scope.agentId}/sandboxes`);
        expect(await request.json()).toEqual({ conversationId });
        awake = true;
        return Response.json({
          sandboxId: "sandbox-1",
          deviceId,
          connectionName: "cloud",
        });
      }
      expect(path).toBe(`/v1/environments/${deviceId}`);
      return Response.json({
        ...environment(),
        deviceId,
        connectionId: awake ? "conn-awake" : null,
        lastHeartbeat: Date.now(),
      });
    });
    const computer = {
      messages: [] as unknown[],
      stops: [] as unknown[],
      async sendSubagentMessage(command: unknown) {
        this.messages.push(command);
        return { success: true, delivery: "steered" };
      },
      async stopSubagent(command: unknown) {
        this.stops.push(command);
        return { success: true, stopped: true, cleanup_confirmed: true };
      },
      close() {},
      onMessage() {
        return () => {};
      },
      onDisconnect() {
        return () => {};
      },
      asClient() {
        return this as unknown as AppServerClient;
      },
    };
    const connections: string[] = [];
    const deps = {
      connect: async (id: string) => {
        connections.push(id);
        return computer.asClient();
      },
    };
    const params = {
      agentId: `codex_22222222-2222-4222-8222-222222222222@${deviceId}`,
      parentScope: scope,
    };
    if (action === "send") {
      expect(
        await sendRemoteExternalCodingAgentMessage(
          { ...params, message: "Review again" },
          deps,
        ),
      ).toEqual({ delivery: "steered" });
      expect(computer.messages).toHaveLength(1);
    } else {
      expect(await stopRemoteExternalCodingAgent(params, deps)).toEqual({
        stopped: true,
      });
      expect(computer.stops).toHaveLength(1);
    }
    expect(connections).toEqual(["conn-awake"]);
    expect(requests).toHaveLength(3);
  });
}

test.each([
  "workstation",
  "sandbox-agent-other-conv-11111111-1111-4111-8111-111111111111-linux-vm",
])("does not wake offline computer %s", async (deviceId) => {
  process.env.LETTA_API_KEY = "test-key";
  process.env.LETTA_BASE_URL = "https://api.example.test";
  let requests = 0;
  mockApiFetch(async (request) => {
    requests++;
    expect(request.method).toBe("GET");
    return Response.json({ ...environment(), deviceId, connectionId: null });
  });
  await expect(
    stopRemoteExternalCodingAgent({
      agentId: `codex_22222222-2222-4222-8222-222222222222@${deviceId}`,
      parentScope: scope,
    }),
  ).rejects.toThrow("offline");
  expect(requests).toBe(1);
});
