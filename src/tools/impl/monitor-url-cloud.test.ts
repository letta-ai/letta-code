import { describe, expect, test } from "bun:test";
import { ApiRequestError } from "@/backend/api/request";
import { monitor } from "./monitor";
import {
  isCloudMonitorId,
  startCloudUrlMonitor,
  stopCloudUrlMonitor,
} from "./monitor-url-cloud";
import { backgroundProcesses } from "./process_manager";
import { task_stop } from "./task-stop";

type Call = { method: string; path: string; body?: Record<string, unknown> };

function fakeRequest(response: unknown, calls: Call[]) {
  return (async (
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ) => {
    calls.push({ method, path, body });
    if (response instanceof Error) throw response;
    return response;
  }) as typeof import("@/backend/api/request").apiRequest;
}

const scope = { agentId: "agent-1", conversationId: "conv-1" };

describe("Monitor url source", () => {
  test("registers with Cloud and returns the Cloud monitor id without local state", async () => {
    const calls: Call[] = [];
    const before = backgroundProcesses.size;
    const result = await startCloudUrlMonitor(
      {
        description: "Deployment status changes",
        url: "https://example.com/status",
        timeout_ms: 3_600_000,
        toolCallId: "call-1",
        parentScope: scope,
      },
      {
        isCloud: () => true,
        request: fakeRequest({ id: "cmon-abc" }, calls),
      },
    );
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/v1/conversations/conv-1/cloud-monitors",
        body: {
          description: "Deployment status changes",
          source: {
            type: "url",
            url: "https://example.com/status",
            interval_seconds: 60,
          },
          timeout_ms: 3_600_000,
          tool_call_id: "call-1",
        },
      },
    ]);
    expect(result.taskId).toBe("cmon-abc");
    expect(result.timeoutMs).toBe(3_600_000);
    expect(result.content[0]?.text).toContain("task cmon-abc");
    expect(backgroundProcesses.size).toBe(before);
  });

  test("sends the interval and the default timeout", async () => {
    const calls: Call[] = [];
    await startCloudUrlMonitor(
      {
        description: "Status",
        url: "https://example.com/",
        interval_seconds: 300,
        parentScope: scope,
      },
      {
        isCloud: () => true,
        request: fakeRequest({ id: "cmon-1" }, calls),
      },
    );
    expect(calls[0]?.body).toMatchObject({
      source: { interval_seconds: 300 },
      timeout_ms: 86_400_000,
    });
    expect(calls[0]?.body).not.toHaveProperty("tool_call_id");
  });

  test("needs a saved conversation, not the default one", async () => {
    const calls: Call[] = [];
    await expect(
      startCloudUrlMonitor(
        {
          description: "Status",
          url: "https://example.com/",
          parentScope: { agentId: "agent-1", conversationId: "default" },
        },
        { isCloud: () => true, request: fakeRequest({}, calls) },
      ),
    ).rejects.toThrow("needs a saved conversation");
    expect(calls).toEqual([]);
  });

  test("explains that url mode needs Letta Cloud", async () => {
    const calls: Call[] = [];
    await expect(
      startCloudUrlMonitor(
        {
          description: "Status",
          url: "https://example.com/",
          parentScope: scope,
        },
        { isCloud: () => false, request: fakeRequest({}, calls) },
      ),
    ).rejects.toThrow("only available when connected to Letta Cloud");
    expect(calls).toEqual([]);
  });

  test.each([
    [{ command: "curl example.com" }, "exactly one of command, ws, or script"],
    [{ ws: { url: "wss://example.com" } }, "exactly one of command, ws"],
    [{ persistent: true }, "does not support persistent"],
    [{ backup_after_seconds: 900 }, "does not support backup_after_seconds"],
    [{ interval_seconds: 30 }, "interval_seconds must be an integer"],
    [{ url: "ftp://example.com/" }, "absolute http or https URL"],
    [{ url: "not a url" }, "absolute http or https URL"],
  ])("rejects invalid url monitor arguments %#", async (extra, message) => {
    const calls: Call[] = [];
    await expect(
      startCloudUrlMonitor(
        {
          description: "Status",
          url: "https://example.com/",
          parentScope: scope,
          ...extra,
        },
        { isCloud: () => true, request: fakeRequest({}, calls) },
      ),
    ).rejects.toThrow(message);
    expect(calls).toEqual([]);
  });

  test("Monitor routes url to Cloud and keeps interval_seconds url-only", async () => {
    await expect(
      monitor({ description: "Status", url: "ftp://example.com/" }),
    ).rejects.toThrow("absolute http or https URL");
    await expect(
      monitor({
        description: "Lines",
        command: "echo hi",
        interval_seconds: 60,
      }),
    ).rejects.toThrow("interval_seconds is only supported with url");
  });
});

describe("TaskStop for Cloud monitors", () => {
  test("recognizes Cloud ids but not local monitor ids", () => {
    expect(isCloudMonitorId("cmon-abc")).toBe(true);
    expect(isCloudMonitorId("monitor_6f1c")).toBe(false);
    expect(isCloudMonitorId("monitor-6f1c")).toBe(false);
  });

  test("routes an unknown Cloud monitor id to the Cloud stop", async () => {
    const stopped: string[] = [];
    const result = await task_stop(
      { task_id: "cmon-abc" },
      {
        stopCloudMonitor: async (id) => {
          stopped.push(id);
          return { killed: true, output: "Stopped" };
        },
      },
    );
    expect(stopped).toEqual(["cmon-abc"]);
    expect(result.killed).toBe(true);
    const local = await task_stop(
      { task_id: "monitor_missing" },
      {
        stopCloudMonitor: async () => {
          throw new Error("must not be called");
        },
      },
    );
    expect(local.killed).toBe(false);
  });

  test("deletes the monitor in the current conversation", async () => {
    const calls: Call[] = [];
    const stopped = await stopCloudUrlMonitor("cmon-abc", {
      isCloud: () => true,
      scope: () => scope,
      request: fakeRequest({ status: "cancelled" }, calls),
    });
    expect(calls).toEqual([
      {
        method: "DELETE",
        path: "/v1/conversations/conv-1/cloud-monitors/cmon-abc",
        body: undefined,
      },
    ]);
    expect(stopped).toEqual({
      killed: true,
      output: "Stopped Cloud monitor cmon-abc.",
    });
  });

  test("reports a monitor that had already stopped or is unknown", async () => {
    const ended = await stopCloudUrlMonitor("cmon-abc", {
      isCloud: () => true,
      scope: () => scope,
      request: fakeRequest({ status: "completed" }, []),
    });
    expect(ended).toEqual({
      killed: false,
      output: "Cloud monitor cmon-abc had already stopped (completed).",
    });
    const gone = await stopCloudUrlMonitor("cmon-abc", {
      isCloud: () => true,
      scope: () => scope,
      request: fakeRequest(
        new ApiRequestError("API error (404)", 404, "", new Headers()),
        [],
      ),
    });
    expect(gone).toEqual({
      killed: false,
      output: "No Cloud monitor cmon-abc was found in this conversation.",
    });
    const calls: Call[] = [];
    const inDefault = await stopCloudUrlMonitor("cmon-abc", {
      isCloud: () => true,
      scope: () => ({ conversationId: "default" }),
      request: fakeRequest({}, calls),
    });
    expect(inDefault.killed).toBe(false);
    expect(calls).toEqual([]);
  });
});
