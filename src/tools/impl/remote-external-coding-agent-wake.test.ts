import { afterEach, beforeAll, expect, mock, spyOn, test } from "bun:test";
import type { AppServerClient } from "@/app-server-client";
import { ComputerResolutionError } from "@/backend/api/environments";
import { settingsManager } from "@/settings-manager";
import { telemetry } from "@/telemetry";
import { REMOTE_SUBAGENT_MESSAGE_TIMEOUT_MS } from "./claude-steer-timeouts";
import {
  classifyRemoteExternalWorkerControlError,
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

test("follow-up ownership rejection distinguishes outdated listeners", async () => {
  const report = spyOn(telemetry, "trackError").mockImplementation(() => {});
  spyOn(telemetry, "flush").mockResolvedValue(undefined);
  const rejection = "Subagent does not belong to this conversation";
  for (const version of ["0.34.24", undefined, "invalid", "0.34.54"]) {
    report.mockClear();
    const resolveComputer = mock(async () => ({
      connectionId: "conn-1",
      environment: {
        ...environment(),
        deviceId: "computer",
        lastHeartbeat: Date.now(),
        connectionId: "conn-1",
        metadata: { subagent_message: true, lettaCodeVersion: version },
      },
    }));
    const close = mock(() => {});
    const client = {
      sendSubagentMessage: async () => ({ success: false, error: rejection }),
      onMessage: () => () => {},
      onDisconnect: () => () => {},
      close,
    } as unknown as AppServerClient;
    await expect(
      sendRemoteExternalCodingAgentMessage(
        {
          agentId: "claude_22222222-2222-4222-8222-222222222222@computer",
          parentScope: scope,
          message: "Continue",
        },
        { resolveComputer, connect: async () => client },
      ),
    ).rejects.toThrow(
      version === "0.34.54"
        ? rejection
        : `computer is running Letta Code ${version ?? "(unknown version)"}, which doesn't keep track of finished or restarted workers, so it can't resume this one. Update Letta Code on computer, or launch a new worker.`,
    );
    expect(JSON.parse(report.mock.calls[0]?.[2] as string).stage).toBe(
      version === "0.34.54" ? "follow_up" : "outdated_computer",
    );
    expect(JSON.parse(report.mock.calls[0]?.[2] as string).error_code).toBe(
      version === "0.34.54" ? "subagent_not_owned" : "outdated_computer",
    );
    expect(resolveComputer).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  }
});

test.each([
  [
    new ComputerResolutionError("computer_offline", "opaque"),
    "computer_offline",
  ],
  [
    new ComputerResolutionError("computer_not_found", "opaque"),
    "computer_not_found",
  ],
  [new ComputerResolutionError("computer_ambiguous", "opaque"), "other"],
  [new ComputerResolutionError("computer_selector_empty", "opaque"), "other"],
  [new Error('Computer "build-box" is offline'), "computer_offline"],
  [
    new Error('Computer "build-box" is offline. Matched: build-box'),
    "computer_offline",
  ],
  [
    new Error(
      'Computer "build-box" not found. Run `letta computers list` to discover available computers.',
    ),
    "computer_not_found",
  ],
  [
    new Error(
      "Timed out waiting for cloud sandbox cloud to come online. Last status: offline",
    ),
    "computer_offline",
  ],
  [
    new Error(
      "Timed out waiting for cloud sandbox cloud to register: unavailable",
    ),
    "computer_offline",
  ],
  [
    new Error("Subagent claude_123 was not found on this computer"),
    "subagent_not_found",
  ],
  [
    new Error("Subagent does not belong to this conversation"),
    "subagent_not_owned",
  ],
  [
    new Error(
      "build-box is running an older Letta Code that can't steer Claude Code subagents remotely. Update Letta Code on build-box.",
    ),
    "outdated_computer",
  ],
  [
    new Error("App-server WebSocket failed to open: HTTP 403: forbidden"),
    "connect_failed",
  ],
  [
    new Error("App-server WebSocket failed to open: closed before opening"),
    "connect_failed",
  ],
  [
    new Error("App-server WebSocket failed to open: timed out after 30000ms"),
    "connect_failed",
  ],
  [
    new Error(
      "App-server WebSocket failed to open: Error: connect ECONNREFUSED",
    ),
    "connect_failed",
  ],
  [new Error("Claude turn did not become interruptible"), "worker_busy"],
  [new Error("Claude interrupt acknowledgement timed out"), "worker_busy"],
  [new Error("unrecognized private detail"), "other"],
  ["unrecognized rejection", "other"],
  [null, "other"],
])("classifies remote control error %s as %s", (error, code) => {
  expect(classifyRemoteExternalWorkerControlError(error)).toBe(code);
});

test("follow-ups wait longer than the listener's worst-case steer", async () => {
  expect(REMOTE_SUBAGENT_MESSAGE_TIMEOUT_MS).toBeGreaterThan(90_000);
  const report = spyOn(telemetry, "trackError").mockImplementation(() => {});
  spyOn(telemetry, "flush").mockResolvedValue(undefined);
  const resolveComputer = mock(async () => ({
    connectionId: "conn-1",
    environment: {
      ...environment(),
      deviceId: "computer",
      lastHeartbeat: Date.now(),
      connectionId: "conn-1",
      metadata: { subagent_message: true, lettaCodeVersion: "0.34.61" },
    },
  }));
  const timeouts: Array<number | undefined> = [];
  const client = {
    sendSubagentMessage: async (
      command: { request_id: string },
      options?: { timeoutMs?: number },
    ) => {
      timeouts.push(options?.timeoutMs);
      throw new Error(`Timed out waiting for ${command.request_id}`);
    },
    onMessage: () => () => {},
    onDisconnect: () => () => {},
    close: () => {},
  } as unknown as AppServerClient;
  await expect(
    sendRemoteExternalCodingAgentMessage(
      {
        agentId: "claude_22222222-2222-4222-8222-222222222222@computer",
        parentScope: scope,
        message: "Continue",
      },
      { resolveComputer, connect: async () => client },
    ),
  ).rejects.toThrow("The message may not have been delivered");
  expect(timeouts).toEqual([REMOTE_SUBAGENT_MESSAGE_TIMEOUT_MS]);
  expect(JSON.parse(report.mock.calls[0]?.[2] as string).error_code).toBe(
    "steer_timeout",
  );
});
