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

test.each([
  { parent: "conv-parent", status: 200, attempts: 1, connects: true },
  { parent: "conv-parent", status: 403, attempts: 2, connects: true },
  { parent: "default", status: 200, attempts: 1, connects: true },
  { parent: "default", status: 403, attempts: 1, connects: false },
  { parent: "conv-parent", status: 400, attempts: 1, connects: false },
  { parent: "conv-parent", status: 403, attempts: 2, connects: false },
])(
  "cloud conversation ancestry and authorization fallback (%j)",
  async (options) => {
    await settingsManager.initialize();
    process.env.LETTA_API_KEY = "test-key";
    process.env.LETTA_BASE_URL = "https://api.example.test";
    spyOn(telemetry, "trackError").mockImplementation(() => {});
    spyOn(telemetry, "flush").mockResolvedValue(undefined);
    const bodies: unknown[] = [];
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
        return Response.json({ deviceId: "device-worker" });
      }
      if (path === "/v1/environments/device-worker")
        return Response.json({
          connectionId: "conn-worker",
          lastHeartbeat: Date.now(),
          metadata: { launch_subagent_notify_caller: true },
        });
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
    }
  },
);
