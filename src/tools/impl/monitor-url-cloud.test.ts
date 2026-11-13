import { describe, expect, spyOn, test } from "bun:test";
import { ApiRequestError } from "@/backend/api/request";
import {
  resolveBackendMode,
  setConfiguredBackendMode,
} from "@/backend/backend-mode";
import { experimentManager } from "@/experiments/manager";
import { monitor } from "./monitor";
import {
  isCloudMonitorId,
  startCloudUrlMonitor,
  stopCloudUrlMonitor,
} from "./monitor-url-cloud";
import {
  backgroundProcesses,
  clearBackgroundProcessCleanup,
} from "./process_manager";
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
  test("create and stop results use local Monitor wording", async () => {
    const flag = spyOn(experimentManager, "isEnabled").mockReturnValue(false);
    const previousMode = resolveBackendMode();
    setConfiguredBackendMode("local");
    let localId: string | undefined;
    try {
      const local = await monitor({
        description: "Status",
        command: "sleep 60",
        timeout_ms: 5000,
      });
      localId = local.taskId;
      const cloud = await startCloudUrlMonitor(
        {
          description: "Status",
          url: "https://example.com",
          timeout_ms: 5000,
          parentScope: scope,
        },
        {
          isCloud: () => true,
          request: fakeRequest({ id: "cmon-compare" }, []),
        },
      );
      // Cloud has no output file; the common message is identical apart from the id.
      expect(cloud.content[0]?.text).toBe(
        local.content[0]?.text
          .split("\nOutput file:")[0]
          ?.replace(local.taskId, cloud.taskId),
      );
      expect(
        await task_stop(
          { task_id: cloud.taskId },
          {
            stopCloudMonitor: (id) =>
              stopCloudUrlMonitor(id, {
                isCloud: () => true,
                scope: () => scope,
                request: fakeRequest({ status: "cancelled" }, []),
              }),
          },
        ),
      ).toEqual(await task_stop({ task_id: local.taskId }));
    } finally {
      if (localId) {
        await task_stop({ task_id: localId });
        clearBackgroundProcessCleanup(localId);
        backgroundProcesses.delete(localId);
      }
      setConfiguredBackendMode(previousMode);
      flag.mockRestore();
    }
  });

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

  test("sends secret header templates, the selected field and the match as written", async () => {
    const calls: Call[] = [];
    const result = await startCloudUrlMonitor(
      {
        description: "Pipeline result",
        url: "https://gitlab.example.com/api/v4/projects/1/pipelines?ref=main",
        headers: {
          "PRIVATE-TOKEN": "$GITLAB_TOKEN",
          Accept: "application/json",
        },
        select: "0.status",
        match: { equals: ["success", "failed", "canceled"] },
        stop_on_match: true,
        parentScope: scope,
      },
      {
        isCloud: () => true,
        request: fakeRequest({ id: "cmon-1" }, calls),
      },
    );
    // $GITLAB_TOKEN stays a reference: Cloud fills it from the agent's
    // secrets on every poll, so the value never leaves the vault.
    expect(calls[0]?.body?.source).toEqual({
      type: "url",
      url: "https://gitlab.example.com/api/v4/projects/1/pipelines?ref=main",
      interval_seconds: 60,
      headers: { "PRIVATE-TOKEN": "$GITLAB_TOKEN", Accept: "application/json" },
      select: { type: "json", path: "0.status" },
      notify_when: {
        type: "match",
        equals: ["success", "failed", "canceled"],
      },
      stop_on_match: true,
    });
    expect(result.content[0]?.text).toContain(
      "You will be notified on each event.",
    );
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
    [
      // Tool arguments arrive as JSON, so a model can send a non-string value.
      { headers: { "X-Count": 1 } as unknown as Record<string, string> },
      "headers must map header names to strings",
    ],
    [
      { headers: { "PRIVATE-TOKEN": "glpat-raw-token" } },
      "must reference an agent secret ($NAME)",
    ],
    [{ select: "" }, "select must be a dot-separated path"],
    [{ match: {} }, "match needs at least one of equals, contains, gt or lt"],
    [{ stop_on_match: true }, "stop_on_match needs match"],
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

  test("Monitor routes url to Cloud and rejects local arguments", async () => {
    const flag = spyOn(experimentManager, "isEnabled").mockReturnValue(true);
    try {
      await expect(
        monitor({ description: "Status", url: "ftp://example.com/" }),
      ).rejects.toThrow("absolute http or https URL");
      await expect(
        monitor({
          description: "Lines",
          command: "echo hi",
          interval_seconds: 60,
        }),
      ).rejects.toThrow("command is not supported in Cloud mode");
      await expect(
        monitor({
          description: "Lines",
          command: "echo hi",
          headers: { Accept: "text/plain" },
        }),
      ).rejects.toThrow("command is not supported in Cloud mode");
    } finally {
      flag.mockRestore();
    }
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
