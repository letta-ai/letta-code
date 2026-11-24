import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { settingsManager } from "@/settings-manager";
import { telemetry } from "@/telemetry";
import { launchRemoteExternalCodingAgent } from "./remote-external-coding-agent";

const originalApiKey = process.env.LETTA_API_KEY;
const originalBaseUrl = process.env.LETTA_BASE_URL;

afterEach(() => {
  mock.restore();
  if (originalApiKey === undefined) delete process.env.LETTA_API_KEY;
  else process.env.LETTA_API_KEY = originalApiKey;
  if (originalBaseUrl === undefined) delete process.env.LETTA_BASE_URL;
  else process.env.LETTA_BASE_URL = originalBaseUrl;
});

const cloudResolutionCases: {
  parent: string;
  status: number;
  attempts: number;
  connects: boolean;
  sandboxStatus?: number;
  pollStatus?: number;
  offline?: boolean;
  errorCode?: string;
  httpStatus?: number;
}[] = [
  { parent: "conv-parent", status: 200, attempts: 1, connects: true },
  { parent: "conv-parent", status: 403, attempts: 2, connects: true },
  { parent: "default", status: 200, attempts: 1, connects: true },
  { parent: "default", status: 403, attempts: 1, connects: false },
  { parent: "conv-parent", status: 400, attempts: 1, connects: false },
  { parent: "conv-parent", status: 403, attempts: 2, connects: false },
  {
    parent: "default",
    status: 200,
    attempts: 1,
    connects: false,
    sandboxStatus: 503,
    errorCode: "cloud_sandbox_create_failed",
    httpStatus: 503,
  },
  {
    parent: "default",
    status: 200,
    attempts: 1,
    connects: false,
    pollStatus: 404,
    errorCode: "cloud_sandbox_register_timeout",
    httpStatus: 404,
  },
  {
    parent: "default",
    status: 200,
    attempts: 1,
    connects: false,
    offline: true,
    errorCode: "cloud_sandbox_online_timeout",
  },
];

test.each(cloudResolutionCases)(
  "cloud worker resolution and conversation authorization fallback (%j)",
  async (options) => {
    await settingsManager.initialize();
    process.env.LETTA_API_KEY = "test-key";
    process.env.LETTA_BASE_URL = "https://api.example.test";
    const trackError = spyOn(telemetry, "trackError").mockImplementation(
      () => {},
    );
    spyOn(telemetry, "flush").mockResolvedValue(undefined);
    const bodies: unknown[] = [];
    let now = Date.now();
    spyOn(Date, "now").mockImplementation(() => now);
    const fetch = (async (input, init) => {
      const request =
        input instanceof Request
          ? new Request(input, init)
          : new Request(input.toString(), init);
      const path = new URL(request.url).pathname;
      if (path === "/v1/conversations/") {
        bodies.push(await request.json());
        if (
          options.status !== 200 &&
          (bodies.length === 1 || !options.connects)
        )
          return Response.json(
            { detail: "Not authorized" },
            { status: options.status },
          );
        return Response.json({ id: "conv-worker" });
      }
      if (path === "/v1/agents/agent-parent/sandboxes") {
        expect(await request.json()).toEqual({ conversationId: "conv-worker" });
        if (options.sandboxStatus)
          return Response.json(
            { detail: "private: 418" },
            { status: options.sandboxStatus },
          );
        return Response.json({
          deviceId: "device-worker",
          connectionName: "worker: 418",
        });
      }
      if (path === "/v1/environments/device-worker") {
        now += 180_000;
        if (options.pollStatus)
          return Response.json(
            { detail: "private: 418" },
            { status: options.pollStatus },
          );
        return Response.json({
          connectionId: options.offline ? null : "conn-worker",
          lastHeartbeat: Date.now(),
          metadata: { launch_subagent_notify_caller: true },
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    }) as typeof globalThis.fetch;
    spyOn(globalThis, "fetch").mockImplementation(fetch);
    const connect = mock(async () => {
      throw new Error("Reached worker");
    });
    const result = await launchRemoteExternalCodingAgent(
      {
        type: "codex",
        computer: "cloud",
        prompt: "Fix the bug",
        description: "Fix the bug",
        parentScope: {
          agentId: "agent-parent",
          conversationId: options.parent,
        },
      },
      {
        spawn: () => {
          throw new Error("Unexpected follow task");
        },
        connect,
      },
    );
    expect(bodies).toEqual([
      {
        hidden: true,
        ...(options.parent !== "default"
          ? { parent_conversation_id: options.parent }
          : {}),
      },
      ...(options.attempts === 2 ? [{ hidden: true }] : []),
    ]);
    expect(connect).toHaveBeenCalledTimes(options.connects ? 1 : 0);
    if (options.connects) {
      expect(connect).toHaveBeenCalledWith("conn-worker", {
        agentId: "agent-parent",
        conversationId: options.parent,
      });
      expect(result).toEqual({
        success: false,
        error: "Can't reach cloud: Reached worker",
      });
    } else {
      expect(trackError.mock.calls).toEqual([
        [
          "external_worker_launch_failed",
          "External worker launch failed",
          JSON.stringify({
            stage: "resolve_computer",
            harness: "codex",
            error_code: options.errorCode ?? "cloud_conversation_create_failed",
            agent_id: "agent-parent",
            conversation_id: options.parent,
          }),
          {
            httpStatus: options.errorCode ? options.httpStatus : options.status,
            omitDebugLogTail: true,
          },
        ],
      ]);
    }
  },
);
