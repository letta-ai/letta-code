import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import {
  deleteMonitorRecord,
  listMonitorRecords,
} from "@/backend/api/monitors";
import * as requests from "@/backend/api/request";
import { monitor } from "./monitor";
import { flushMonitorState } from "./monitor-state";
import { backgroundProcesses } from "./process_manager";
import { task_stop } from "./task-stop";

const previousManaged = process.env.LETTA_MANAGED_CLOUD_RUNTIME;
const calls: Array<{
  method: string;
  path: string;
  body: unknown;
  options: unknown;
}> = [];
const request = spyOn(requests, "apiRequest").mockImplementation(
  async (method, path, body, options) => {
    calls.push({ method, path, body, options });
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
  if (previousManaged === undefined)
    delete process.env.LETTA_MANAGED_CLOUD_RUNTIME;
  else process.env.LETTA_MANAGED_CLOUD_RUNTIME = previousManaged;
});

afterAll(() => request.mockRestore());

test("Cloud Monitor persists scoped state and TaskStop updates its API-generated ID", async () => {
  process.env.LETTA_MANAGED_CLOUD_RUNTIME = "1";
  const result = await monitor({
    description: "watch build",
    command: "sleep 30",
    parentScope: { agentId: "agent-test", conversationId: "default" },
  });
  expect(result.taskId).toBe("monitor-cloud-test");
  expect(calls[0]).toMatchObject({
    method: "POST",
    path: "/v1/monitors",
    body: {
      agent_id: "agent-test",
      conversation_id: "default",
      description: "watch build",
      command: "sleep 30",
      kind: "command",
      status: "running",
      persistent: false,
    },
  });
  expect(calls[1]).toMatchObject({
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
});

test("local execution retains the in-memory Monitor store without API calls", async () => {
  delete process.env.LETTA_MANAGED_CLOUD_RUNTIME;
  const result = await monitor({
    description: "local watch",
    command: "sleep 30",
    parentScope: { agentId: "agent-test", conversationId: "conv-test" },
  });
  expect(backgroundProcesses.get(result.taskId)).toMatchObject({
    kind: "monitor",
    status: "running",
    command: "sleep 30",
  });
  await task_stop({ task_id: result.taskId });
  expect(backgroundProcesses.get(result.taskId)?.status).toBe("failed");
  expect(calls).toEqual([]);
});
