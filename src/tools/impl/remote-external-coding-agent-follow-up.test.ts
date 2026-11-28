import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { createAppServerClient } from "@/app-server-client";
import { settingsManager } from "@/settings-manager";
import { telemetry } from "@/telemetry";
import { formatExternalCodingAgentId } from "./external-coding-agent";
import {
  classifyRemoteExternalWorkerControlError,
  sendRemoteExternalCodingAgentMessage,
} from "./remote-external-coding-agent";

const originalBaseUrl = process.env.LETTA_BASE_URL;

afterEach(() => {
  mock.restore();
  if (originalBaseUrl === undefined) delete process.env.LETTA_BASE_URL;
  else process.env.LETTA_BASE_URL = originalBaseUrl;
});

const conversationId = "conv-00000000-0000-4000-8000-000000000001";
const deviceId = `sandbox-agent-parent-${conversationId}-linux-vm`;
const sessionId = "00000000-0000-4000-8000-000000000002";
const sandbox = { deviceId, connectionName: "worker" };

const wakeResponses = [
  { status: 410, body: {}, lookupStatus: 200, expires: true },
  {
    status: 409,
    body: { code: "SANDBOX_EXPIRED" },
    lookupStatus: 404,
    expires: true,
  },
  {
    status: 200,
    body: { ...sandbox, resumed: false },
    lookupStatus: 200,
    expires: true,
  },
  {
    status: 201,
    body: { ...sandbox, resumed: false },
    lookupStatus: 200,
    expires: true,
  },
  {
    status: 200,
    body: { ...sandbox, resumed: true },
    lookupStatus: 200,
    expires: false,
  },
];

test.each(wakeResponses)("cloud worker follow-up wake (%j)", async (wake) => {
  await settingsManager.initialize();
  process.env.LETTA_BASE_URL = "https://api.example.test";
  const trackError = spyOn(telemetry, "trackError").mockImplementation(
    () => {},
  );
  spyOn(telemetry, "flush").mockResolvedValue(undefined);
  const wakeRequests: unknown[] = [];
  let lookups = 0;
  const fetch = (async (input, init) => {
    const request =
      input instanceof Request
        ? new Request(input, init)
        : new Request(input.toString(), init);
    const path = new URL(request.url).pathname;
    if (
      path === "/v1/agents/agent-parent/sandboxes" &&
      request.method === "POST"
    ) {
      wakeRequests.push(await request.json());
      return Response.json(wake.body, { status: wake.status });
    }
    if (path === `/v1/environments/${deviceId}` && request.method === "GET") {
      lookups++;
      if (lookups === 1 && wake.lookupStatus === 404)
        return Response.json({}, { status: 404 });
      return Response.json({
        ...sandbox,
        connectionId: lookups === 1 ? null : "conn-worker",
        lastHeartbeat: Date.now(),
        metadata: { subagent_message: true },
      });
    }
    throw new Error(`Unexpected request: ${request.method} ${path}`);
  }) as typeof globalThis.fetch;
  spyOn(globalThis, "fetch").mockImplementation(fetch);
  const client = createAppServerClient({
    url: "ws://worker.example.test",
    WebSocket: class {
      readyState = 1;
      on() {}
      send() {}
      close() {}
    },
  });
  const send = spyOn(client, "sendSubagentMessage").mockImplementation(
    async ({ request_id }) => ({
      type: "subagent_message_response",
      request_id: request_id ?? "test-request",
      success: true,
      delivery: "steered",
    }),
  );
  const connect = mock(async (_connectionId: string) => client);

  const result = sendRemoteExternalCodingAgentMessage(
    {
      agentId: formatExternalCodingAgentId("claude-code", sessionId, deviceId),
      parentScope: { agentId: "agent-parent", conversationId: "conv-parent" },
      message: "Continue the task",
    },
    { connect },
  );

  if (wake.expires) {
    const error = await result.catch((error: unknown) => error);
    expect(error).toMatchObject({
      message:
        "The worker's cloud sandbox expired and was deleted. Launch a new worker with Agent.",
    });
    expect(classifyRemoteExternalWorkerControlError(error)).toBe(
      "sandbox_expired",
    );
    expect(lookups).toBe(1);
    expect(connect).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  } else {
    expect(await result).toEqual({ delivery: "steered" });
    expect(connect).toHaveBeenCalledWith("conn-worker", {
      agentId: "agent-parent",
      conversationId: "conv-parent",
    });
    expect(send).toHaveBeenCalledTimes(1);
  }
  expect(wakeRequests).toEqual([{ conversationId, resumeOnly: true }]);
  expect(trackError).not.toHaveBeenCalled();
});
