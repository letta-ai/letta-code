import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { LETTA_CLOUD_API_URL } from "@/auth/oauth";
import {
  deleteMonitorRecord,
  listMonitorRecords,
} from "@/backend/api/monitors";
import * as requests from "@/backend/api/request";
import { runWithRuntimeContext } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";
import { monitor } from "./monitor";
import { flushMonitorState } from "./monitor-state";
import { backgroundProcesses } from "./process_manager";
import { task_stop } from "./task-stop";

const envKeys = [
  "LETTA_MANAGED_CLOUD_RUNTIME",
  "LETTA_DESKTOP_MODE",
  "LETTA_RUNTIME_SESSION_SOURCE",
  "LETTA_RUNTIME_ENVIRONMENT_DEVICE_ID",
  "LETTA_BASE_URL",
] as const;
let previousEnv: Array<string | undefined>;
let routesUnavailable = false;
let monitorUnavailable = false;
const initialize = spyOn(settingsManager, "initialize").mockResolvedValue();
beforeEach(() => {
  previousEnv = envKeys.map((key) => process.env[key]);
  for (const key of envKeys) delete process.env[key];
  process.env.LETTA_BASE_URL = LETTA_CLOUD_API_URL;
  routesUnavailable = false;
  monitorUnavailable = false;
});
const calls: Array<{
  method: string;
  path: string;
  body: unknown;
  options: unknown;
}> = [];
const request = spyOn(requests, "apiRequest").mockImplementation(
  async (method, path, body, options) => {
    calls.push({ method, path, body, options });
    if (path.startsWith("/v1/environments/"))
      return { deviceId: "device-test", organizationId: "org-test" } as never;
    if (path.endsWith("/schedule")) {
      if (routesUnavailable)
        throw new requests.ApiRequestError(
          "routes unavailable",
          404,
          "not found",
        );
      return { scheduled_messages: [], has_next_page: false } as never;
    }
    if (monitorUnavailable)
      throw new requests.ApiRequestError(
        "monitor route unavailable",
        404,
        "not found",
      );
    if (method === "GET") return [] as never;
    return { monitor_id: "monitor-cloud-test", ...body } as never;
  },
);

afterEach(async () => {
  for (const [id, process] of backgroundProcesses) {
    if (process.status === "running") await task_stop({ task_id: id });
  }
  backgroundProcesses.clear();
  calls.length = 0;
  envKeys.forEach((key, index) => {
    const value = previousEnv[index];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
});

afterAll(() => {
  request.mockRestore();
  initialize.mockRestore();
});

test("registered Cloud listeners persist Monitor state and unavailable Cloud routes never fall back", async () => {
  const context = {
    sessionSource: "listen" as const,
    environmentDeviceId: "device-test",
    actingUserId: "user-test",
  };
  const input = {
    description: "watch build",
    command: "sleep 30",
    parentScope: { agentId: "agent-test", conversationId: "default" },
  };
  const result = await runWithRuntimeContext(context, () =>
    monitor({
      description: "watch build",
      command: "sleep 30",
      parentScope: { agentId: "agent-test", conversationId: "default" },
    }),
  );
  const storageCalls = calls.filter((call) =>
    call.path.startsWith("/v1/monitors"),
  );
  expect(
    calls.some((call) => call.path === "/v1/environments/device-test"),
  ).toBe(true);
  expect(result.taskId).toBe("monitor-cloud-test");
  expect(storageCalls[0]).toMatchObject({
    method: "POST",
    path: "/v1/monitors",
    body: {
      agent_id: "agent-test",
      conversation_id: "default",
      device_id: "device-test",
      description: "watch build",
      command: "sleep 30",
      kind: "command",
      status: "running",
      persistent: false,
    },
    options: { actingUserId: "user-test" },
  });
  expect(storageCalls[1]).toMatchObject({
    method: "PATCH",
    path: "/v1/monitors/monitor-cloud-test",
    body: {
      status: "running",
      output_file: expect.any(String),
      started_at: expect.any(String),
    },
  });
  expect(await task_stop({ task_id: result.taskId })).toMatchObject({
    killed: true,
  });
  await flushMonitorState(result.taskId);
  expect(calls.at(-1)).toMatchObject({
    method: "PATCH",
    path: "/v1/monitors/monitor-cloud-test",
    body: { status: "failed" },
  });
  await listMonitorRecords({
    agent_id: "agent-test",
    conversation_id: "conv-test",
  });
  expect(calls.at(-1)).toMatchObject({
    method: "GET",
    path: "/v1/monitors",
    options: {
      query: {
        agent_id: "agent-test",
        conversation_id: "conv-test",
        limit: 200,
      },
    },
  });
  await deleteMonitorRecord(result.taskId);
  expect(calls.at(-1)).toMatchObject({
    method: "DELETE",
    path: "/v1/monitors/monitor-cloud-test",
  });
  monitorUnavailable = true;
  await expect(
    runWithRuntimeContext(context, () => monitor(input)),
  ).rejects.toThrow(
    "Couldn't save the monitor: monitor route unavailable. Retry.",
  );
  expect(
    [...backgroundProcesses.values()].some(
      (process) => process.status === "running",
    ),
  ).toBe(false);
  monitorUnavailable = false;
  await expect(
    runWithRuntimeContext(
      { sessionSource: "headless", environmentDeviceId: null },
      () => monitor(input),
    ),
  ).rejects.toThrow("must be registered");
  routesUnavailable = true;
  await expect(
    runWithRuntimeContext(context, () => monitor(input)),
  ).rejects.toThrow("Cloud schedules are unavailable");
});

test("TUI, Desktop, local agents and self-hosted servers without routes retain in-memory Monitor storage", async () => {
  for (const mode of [
    "tui",
    "desktop",
    "local-agent",
    "self-hosted",
  ] as const) {
    if (mode === "desktop") process.env.LETTA_DESKTOP_MODE = "1";
    else delete process.env.LETTA_DESKTOP_MODE;
    process.env.LETTA_BASE_URL =
      mode === "self-hosted" ? "http://localhost:8283" : LETTA_CLOUD_API_URL;
    routesUnavailable = mode === "self-hosted";
    const result = await runWithRuntimeContext(
      { sessionSource: mode === "tui" ? "interactive-cli" : "headless" },
      () =>
        monitor({
          description: "local watch",
          command: "sleep 30",
          parentScope: {
            agentId: mode === "local-agent" ? "agent-local-test" : "agent-test",
            conversationId: "conv-test",
          },
        }),
    );
    expect(backgroundProcesses.get(result.taskId)).toMatchObject({
      kind: "monitor",
      status: "running",
      command: "sleep 30",
    });
    await task_stop({ task_id: result.taskId });
    expect(backgroundProcesses.get(result.taskId)?.status).toBe("failed");
  }
  expect(calls.filter((call) => call.path.startsWith("/v1/monitors"))).toEqual(
    [],
  );
});
