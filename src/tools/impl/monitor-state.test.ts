import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MonitorState } from "@/backend/api/monitors";
import {
  resolveBackendMode,
  setConfiguredBackendMode,
} from "@/backend/backend-mode";
import { runWithRuntimeContext } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";
import {
  clearPendingMessages,
  setMessageQueueAdder,
} from "@/utils/message-queue-bridge";
import { monitor } from "./monitor";
import { withMonitorState } from "./monitor-state";
import {
  backgroundProcesses,
  clearBackgroundProcessCleanup,
} from "./process_manager";
import { task_stop } from "./task-stop";
import { watch_pr } from "./watch-pr";

const originalMode = resolveBackendMode();
const originalHome = process.env.HOME;
const originalUrl = process.env.LETTA_BASE_URL;
let home: string;
let server: ReturnType<typeof Bun.serve>;
let rejectCreate: boolean;
let legacyServer: boolean;
let legacyValidation: "generic" | "zod";
let rejectFirstPatch: boolean;
let rejectUpdates: boolean;
let requests: Array<{ method: string; actor: string | null; body: unknown }>;
let record: MonitorState | undefined;
let existingProcessIds: Set<string>;

beforeEach(async () => {
  existingProcessIds = new Set(backgroundProcesses.keys());
  home = mkdtempSync(join(tmpdir(), "monitor-state-"));
  process.env.HOME = home;
  await settingsManager.reset();
  await settingsManager.initialize();
  setConfiguredBackendMode("api");
  rejectCreate = false;
  legacyServer = false;
  legacyValidation = "generic";
  setMessageQueueAdder(() => {});
  clearPendingMessages();
  rejectFirstPatch = false;
  rejectUpdates = false;
  requests = [];
  record = undefined;
  // HTTP protocol fixture: lifecycle sources and the API request client are real.
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method === "GET")
        return Response.json(record ?? { detail: "Not found" }, {
          status: record ? 200 : 404,
        });
      const body = (await request.json()) as Partial<MonitorState>;
      if (
        legacyServer &&
        (body.args ||
          body.expires_at !== undefined ||
          ["stopped", "expired", "paused"].includes(body.status ?? ""))
      )
        return Response.json(
          legacyValidation === "generic"
            ? { detail: "Invalid request" }
            : {
                issues: [
                  request.method === "POST"
                    ? {
                        code: "unrecognized_keys",
                        keys: ["expires_at", "args"],
                        path: [],
                      }
                    : { code: "invalid_enum_value", path: ["status"] },
                ],
              },
          { status: 400 },
        );
      requests.push({
        method: request.method,
        actor: request.headers.get("X-Letta-Acting-User-Id"),
        body,
      });
      if (request.method === "PATCH" && (rejectFirstPatch || rejectUpdates)) {
        rejectFirstPatch = false;
        return Response.json({ detail: "Unavailable" }, { status: 503 });
      }
      if (request.method === "POST") {
        if (rejectCreate)
          return Response.json({ detail: "Unavailable" }, { status: 503 });
        record = {
          ...body,
          monitor_id: `monitor-${crypto.randomUUID()}`,
        } as MonitorState;
      } else record = { ...record, ...body } as MonitorState;
      return Response.json(record, {
        status: request.method === "POST" ? 201 : 200,
      });
    },
  });
  process.env.LETTA_BASE_URL = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  setMessageQueueAdder(null);
  clearPendingMessages();
  for (const [id, process] of backgroundProcesses) {
    if (existingProcessIds.has(id)) continue;
    process.completionNotificationSuppressed = true;
    process.process.kill("SIGKILL");
    await process.persistState?.().catch(() => {});
    clearBackgroundProcessCleanup(id);
    backgroundProcesses.delete(id);
  }
  server.stop(true);
  setConfiguredBackendMode(originalMode);
  await settingsManager.reset();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUrl === undefined) delete process.env.LETTA_BASE_URL;
  else process.env.LETTA_BASE_URL = originalUrl;
  rmSync(home, { recursive: true, force: true });
});

const scope = { agentId: "agent-test", conversationId: "conv-test" };

test("API create failure prevents the source from starting", async () => {
  rejectCreate = true;
  let started = false;
  await expect(
    withMonitorState(
      {
        description: "Unavailable store",
        command: "unused",
        kind: "command",
        persistent: false,
        parentScope: scope,
      },
      () => {
        started = true;
      },
    ),
  ).rejects.toThrow("503");
  expect(started).toBe(false);
  expect(
    [...backgroundProcesses.keys()].filter((id) => !existingProcessIds.has(id)),
  ).toEqual([]);
});

test("server ID, captured actor and redacted metadata survive a stop in another turn", async () => {
  const source = `"${process.execPath}" -e "setInterval(() => {}, 1000)"`;
  const result = await runWithRuntimeContext(
    {
      ...scope,
      actingUserId: "user-starter",
      environmentDeviceId: "device-test",
    },
    () =>
      monitor({
        description: 'Wait for sentinel-"secret',
        command: source,
        secretEnv: { SENTINEL: 'sentinel-"secret' },
        persistent: true,
        parentScope: scope,
      }),
  );
  expect(record?.monitor_id).toBe(result.taskId);
  expect(record).toMatchObject({
    agent_id: scope.agentId,
    conversation_id: scope.conversationId,
    device_id: "device-test",
    status: "running",
  });
  expect(record?.description).not.toContain('sentinel-"secret');
  expect(record?.args).not.toHaveProperty("secretEnv");
  expect(record?.args?.description).not.toContain('sentinel-"secret');

  await runWithRuntimeContext({ actingUserId: "user-stopper" }, () =>
    task_stop({ task_id: result.taskId }),
  );
  expect(record?.status).toBe("stopped");
  expect(requests.every((request) => request.actor === "user-starter")).toBe(
    true,
  );
});

test("startup failure persists failed and conversation-only scope keeps agent_id null", async () => {
  await expect(
    runWithRuntimeContext(
      {
        agentId: null,
        conversationId: "conv-only",
        suppressActingUserFallback: true,
      },
      () =>
        withMonitorState(
          {
            description: "Fail at startup",
            command: "unused",
            kind: "script",
            persistent: false,
          },
          () => {
            throw new Error("Startup failed");
          },
        ),
    ),
  ).rejects.toThrow("Startup failed");
  expect(record).toMatchObject({
    agent_id: null,
    conversation_id: "conv-only",
    status: "failed",
  });
  expect(requests.every((request) => request.actor === null)).toBe(true);
});

test("local monitors do not contact the server", async () => {
  setConfiguredBackendMode("local");
  const id = await withMonitorState(
    {
      description: "Local",
      command: "unused",
      kind: "command",
      persistent: false,
    },
    (id) => id,
  );
  expect(id.startsWith("monitor_")).toBe(true);
  expect(requests).toHaveLength(0);
});

test("a failed cleanup write preserves the original startup error", async () => {
  rejectUpdates = true;
  await expect(
    withMonitorState(
      {
        description: "Failed cleanup",
        command: "unused",
        kind: "command",
        persistent: false,
        parentScope: scope,
      },
      () => {
        throw new Error("Original startup failure");
      },
    ),
  ).rejects.toThrow("Original startup failure");
});

test("failure to persist startup metadata stops the newly launched source", async () => {
  rejectFirstPatch = true;
  await expect(
    monitor({
      description: "Startup write failure",
      parentScope: scope,
      persistent: true,
      command: `"${process.execPath}" -e "setInterval(() => {}, 1000)"`,
    }),
  ).rejects.toThrow("503");
  expect(record?.status).toBe("failed");
  const source = record && backgroundProcesses.get(record.monitor_id);
  expect(source?.status).toBe("failed");
  expect(source?.cleanupTimer).toBeDefined();
  await source?.completion?.catch(() => {});
});

test("a failed status write does not report a stopped process as still running", async () => {
  const result = await monitor({
    description: "Stop write failure",
    parentScope: scope,
    persistent: true,
    command: `"${process.execPath}" -e "setInterval(() => {}, 1000)"`,
  });
  rejectUpdates = true;
  try {
    expect(await task_stop({ task_id: result.taskId })).toEqual({
      killed: true,
      output: "Monitor stopped, but its server state could not be saved",
    });
    expect(backgroundProcesses.get(result.taskId)?.status).toBe("failed");
  } finally {
    rejectUpdates = false;
  }
});

test("resume restores saved arguments under the same id without creating a row", async () => {
  const started = await monitor({
    description: "Resume saved command",
    command: `"${process.execPath}" -e "setInterval(() => {}, 1000)"`,
    persistent: true,
    parentScope: scope,
  });
  await task_stop({ task_id: started.taskId });
  if (!record) throw new Error("Missing saved monitor");
  record.status = "paused";
  record.expires_at = new Date(Date.now() + 60000).toISOString();
  const resumed = await monitor({ resume: started.taskId, parentScope: scope });
  expect(resumed.taskId).toBe(started.taskId);
  expect(String(record.status)).toBe("running");
  expect(record.description).toBe("Resume saved command");
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(
    1,
  );
  await task_stop({ task_id: resumed.taskId });
  expect(String(record.status)).toBe("stopped");
});

test("expired resumes never start a process and timeout persists expired", async () => {
  const started = await monitor({
    description: "Short watch",
    command: `"${process.execPath}" -e "setInterval(() => {}, 1000)"`,
    timeout_ms: 1000,
    parentScope: scope,
  });
  await new Promise((resolve) => setTimeout(resolve, 1300));
  await backgroundProcesses.get(started.taskId)?.persistState?.();
  expect(record?.status).toBe("expired");
  if (!record) throw new Error("Missing saved monitor");
  record.status = "paused";
  record.expires_at = new Date(Date.now() - 1000).toISOString();
  await expect(
    monitor({ resume: started.taskId, parentScope: scope }),
  ).rejects.toThrow("has expired");
  expect(String(record.status)).toBe("expired");
  expect(backgroundProcesses.get(started.taskId)?.status).toBe("failed");
});

test.each(["generic", "zod"] as const)(
  "strict older servers still create and stop monitors (%s)",
  async (validation) => {
    legacyValidation = validation;
    legacyServer = true;
    const started = await monitor({
      description: "Legacy compatibility",
      command: `"${process.execPath}" -e "setInterval(() => {}, 1000)"`,
      persistent: true,
      parentScope: scope,
    });
    expect(record?.args).toBeUndefined();
    expect((await task_stop({ task_id: started.taskId })).killed).toBe(true);
    expect(record?.status).toBe("failed");
  },
);

test("WatchPR resume restores filters and the original id", async () => {
  const url = "https://github.com/example/repo/pull/1";
  record = {
    monitor_id: "monitor-saved",
    agent_id: scope.agentId,
    conversation_id: scope.conversationId,
    description: "Saved PR",
    kind: "github_pull_request",
    command: url,
    status: "paused",
    persistent: false,
    device_id: null,
    started_at: new Date().toISOString(),
    output_file: null,
    exit_code: null,
    expires_at: new Date(Date.now() + 60000).toISOString(),
    args: { url, notify_on: ["merged"] },
  };
  const result = await watch_pr(
    { resume: record.monitor_id, parentScope: scope },
    {
      fetchSnapshot: async () => ({
        ref: { owner: "example", repo: "repo", number: 1, url },
        headSha: "a".repeat(40),
        state: "OPEN",
        isDraft: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        reviewDecision: "APPROVED",
        readinessConfirmed: true,
        checks: [],
        checkAttempts: [],
        comments: [],
        reviews: [],
        reviewThreads: [],
      }),
    },
  );
  expect(result.taskId).toBe("monitor-saved");
  expect(record.status).toBe("running");
  expect(result.content[0]?.text).toContain("merged");
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(
    0,
  );
  await task_stop({ task_id: result.taskId });
});
