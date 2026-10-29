import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfiguredBackendMode } from "@/backend/backend-mode";
import { runCronSubcommand } from "@/cli/subcommands/cron";
import { listTasks } from "@/cron";
import { settingsManager } from "@/settings-manager";

const originalFetch = globalThis.fetch;
const originalInitialize = settingsManager.initialize;
const originalGetSettingsWithSecureTokens =
  settingsManager.getSettingsWithSecureTokens;
const originalGetOrCreateDeviceId = settingsManager.getOrCreateDeviceId;
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalBaseUrl = process.env.LETTA_BASE_URL;
const originalApiKey = process.env.LETTA_API_KEY;
const originalRuntimeDeviceId = process.env.LETTA_RUNTIME_ENVIRONMENT_DEVICE_ID;
const originalManagedCloudRuntime = process.env.LETTA_MANAGED_CLOUD_RUNTIME;
const originalConversationId = process.env.LETTA_CONVERSATION_ID;
const originalActingUserId = process.env.LETTA_ACTING_USER_ID;
const originalLettaHome = process.env.LETTA_HOME;

const addArgs = [
  "add",
  "--name",
  "boundary-test",
  "--description",
  "exercise schedule creation",
  "--prompt",
  "do the scheduled work",
  "--every",
  "5m",
  "--agent",
  "agent-cloud-test",
  "--conversation",
  "conversation-test",
];

function withoutConversationArgument(args: string[]): string[] {
  const index = args.indexOf("--conversation");
  if (index < 0) return [...args];
  return [...args.slice(0, index), ...args.slice(index + 2)];
}

function environment(deviceId: string) {
  const now = Date.now();
  return {
    id: `environment-${deviceId}`,
    connectionId: `connection-${deviceId}`,
    deviceId,
    connectionName: "external listener",
    organizationId: "org-test",
    podId: null,
    connectedAt: now,
    lastHeartbeat: now,
    lastSeenAt: now,
    firstSeenAt: now,
  };
}

function legacyCloudSchedule() {
  return {
    id: "legacy-cloud-schedule",
    agent_id: "agent-cloud-test",
    name: "legacy cloud schedule",
    description: "created before environment-owned scheduling",
    conversation_id: "conversation-test",
    message: { messages: [{ role: "user", content: "legacy work" }] },
    schedule: { type: "recurring", cron_expression: "0 * * * *" },
    next_scheduled_time: "2026-09-25T01:00:00.000Z",
    use_sandbox: true,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installScheduleApi(options: {
  environments?: Record<string, ReturnType<typeof environment>>;
  scheduleRoutesStatus?: number;
  scheduledMessages?: unknown[];
}) {
  const requests: Array<{
    method: string;
    pathname: string;
    body: Record<string, unknown> | undefined;
    actingUserId: string | null;
  }> = [];

  globalThis.fetch = mock(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    requests.push({
      method,
      pathname: url.pathname,
      body,
      actingUserId:
        new Headers(init?.headers).get("X-Letta-Acting-User-Id") ?? null,
    });

    if (
      method === "GET" &&
      url.pathname === "/v1/agents/agent-cloud-test/schedule"
    ) {
      return options.scheduleRoutesStatus
        ? jsonResponse(
            { error: "schedule route unavailable" },
            options.scheduleRoutesStatus,
          )
        : jsonResponse({
            scheduled_messages: options.scheduledMessages ?? [],
            has_next_page: false,
          });
    }

    if (
      url.pathname ===
      "/v1/agents/agent-cloud-test/schedule/legacy-cloud-schedule"
    ) {
      if (method === "GET") return jsonResponse(legacyCloudSchedule());
      if (method === "DELETE") return jsonResponse({ success: true });
    }

    if (method === "GET" && url.pathname.startsWith("/v1/environments/")) {
      const deviceId = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      const found = options.environments?.[deviceId];
      return found
        ? jsonResponse(found)
        : jsonResponse({ error: "environment not found" }, 404);
    }

    if (
      method === "POST" &&
      url.pathname === "/v1/agents/agent-cloud-test/schedule"
    ) {
      return jsonResponse({
        id: "schedule-test",
        use_sandbox: true,
        target_device_id:
          typeof body?.target_device_id === "string"
            ? body.target_device_id
            : null,
      });
    }

    return jsonResponse({ error: "unexpected request" }, 500);
  }) as unknown as typeof fetch;

  return requests;
}

beforeEach(() => {
  setConfiguredBackendMode("api");
  process.env.LETTA_BASE_URL = "https://example.test";
  process.env.LETTA_API_KEY = "test-key";
  delete process.env.LETTA_RUNTIME_ENVIRONMENT_DEVICE_ID;
  delete process.env.LETTA_MANAGED_CLOUD_RUNTIME;
  delete process.env.LETTA_CONVERSATION_ID;
  delete process.env.LETTA_ACTING_USER_ID;
  settingsManager.initialize = mock(
    async () => {},
  ) as typeof settingsManager.initialize;
  settingsManager.getSettingsWithSecureTokens = mock(async () => ({
    env: {
      LETTA_BASE_URL: "https://example.test",
      LETTA_API_KEY: "test-key",
    },
  })) as unknown as typeof settingsManager.getSettingsWithSecureTokens;
  settingsManager.getOrCreateDeviceId = mock(
    () => "device-persisted",
  ) as typeof settingsManager.getOrCreateDeviceId;
  console.log = mock(() => {});
  console.error = mock(() => {});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  settingsManager.initialize = originalInitialize;
  settingsManager.getSettingsWithSecureTokens =
    originalGetSettingsWithSecureTokens;
  settingsManager.getOrCreateDeviceId = originalGetOrCreateDeviceId;
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
  setConfiguredBackendMode("api");

  for (const [key, value] of [
    ["LETTA_BASE_URL", originalBaseUrl],
    ["LETTA_API_KEY", originalApiKey],
    ["LETTA_RUNTIME_ENVIRONMENT_DEVICE_ID", originalRuntimeDeviceId],
    ["LETTA_MANAGED_CLOUD_RUNTIME", originalManagedCloudRuntime],
    ["LETTA_CONVERSATION_ID", originalConversationId],
    ["LETTA_ACTING_USER_ID", originalActingUserId],
    ["LETTA_HOME", originalLettaHome],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("cron add execution targeting", () => {
  test("Cloud schedules default to a new conversation per fire and ignore ambient conversation state", async () => {
    process.env.LETTA_MANAGED_CLOUD_RUNTIME = "1";
    process.env.LETTA_CONVERSATION_ID = "ambient-conversation";
    const requests = installScheduleApi({});

    expect(await runCronSubcommand(withoutConversationArgument(addArgs))).toBe(
      0,
    );

    expect(
      requests.find((request) => request.method === "POST")?.body,
    ).toMatchObject({ conversation_id: "new" });
  });

  test("local schedules default to a new conversation per fire and ignore ambient conversation state", async () => {
    const home = mkdtempSync(join(tmpdir(), "letta-cron-conversation-test-"));
    process.env.LETTA_HOME = home;
    process.env.LETTA_CONVERSATION_ID = "ambient-conversation";
    installScheduleApi({});
    const logs: string[] = [];
    console.log = mock((line: string) => {
      logs.push(String(line));
    });

    try {
      expect(
        await runCronSubcommand(withoutConversationArgument(addArgs)),
      ).toBe(0);

      const output = JSON.parse(logs.join("")) as Record<string, unknown>;
      expect(output.conversation_id).toBe("new");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("--conversation self captures the current conversation", async () => {
    process.env.LETTA_MANAGED_CLOUD_RUNTIME = "1";
    process.env.LETTA_CONVERSATION_ID = "current-conversation";
    const requests = installScheduleApi({});

    expect(
      await runCronSubcommand([
        ...withoutConversationArgument(addArgs),
        "--conversation",
        "self",
      ]),
    ).toBe(0);

    expect(
      requests.find((request) => request.method === "POST")?.body,
    ).toMatchObject({ conversation_id: "current-conversation" });
  });

  test("--conversation self fails without a current conversation", async () => {
    const requests = installScheduleApi({});
    const errors: string[] = [];
    console.error = mock((line: string) => errors.push(String(line)));

    expect(
      await runCronSubcommand([
        ...withoutConversationArgument(addArgs),
        "--conversation",
        "self",
      ]),
    ).toBe(1);

    expect(errors).toContain(
      "Error: --conversation self requires an active conversation (LETTA_CONVERSATION_ID is not set).",
    );
    expect(requests.some((request) => request.method === "POST")).toBe(false);
  });

  test("Cloud API-backed local execution creates a local schedule without calling the schedule API", async () => {
    const home = mkdtempSync(join(tmpdir(), "letta-cron-local-environment-"));
    process.env.LETTA_HOME = home;
    process.env.LETTA_RUNTIME_ENVIRONMENT_DEVICE_ID = "registered-device";
    const requests = installScheduleApi({
      environments: { "registered-device": environment("registered-device") },
    });
    const logs: string[] = [];
    console.log = mock((line: string) => logs.push(String(line)));

    try {
      expect(await runCronSubcommand(addArgs)).toBe(0);
      expect(requests).toHaveLength(0);
      expect(JSON.parse(logs.join(""))).toMatchObject({ runner: "local" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("managed sandbox creates an untargeted Cloud schedule even with an unregistered listener device", async () => {
    process.env.LETTA_MANAGED_CLOUD_RUNTIME = "1";
    process.env.LETTA_RUNTIME_ENVIRONMENT_DEVICE_ID = "unregistered-device";
    const requests = installScheduleApi({});

    expect(await runCronSubcommand(addArgs)).toBe(0);

    expect(
      requests.some((request) =>
        request.pathname.startsWith("/v1/environments/"),
      ),
    ).toBe(false);
    expect(requests.find((request) => request.method === "POST")?.body).toEqual(
      {
        name: "boundary-test",
        description: "exercise schedule creation",
        conversation_id: "conversation-test",
        messages: [{ role: "user", content: "do the scheduled work" }],
        schedule: { type: "recurring", cron_expression: "*/5 * * * *" },
        use_sandbox: true,
      },
    );
  });

  test("managed sandbox never falls back to a local schedule when Cloud routes are unavailable", async () => {
    const home = mkdtempSync(join(tmpdir(), "letta-cron-cloud-failure-"));
    process.env.LETTA_HOME = home;
    process.env.LETTA_MANAGED_CLOUD_RUNTIME = "1";
    const requests = installScheduleApi({ scheduleRoutesStatus: 404 });

    try {
      expect(await runCronSubcommand(addArgs)).toBe(1);
      expect(requests.some((request) => request.method === "POST")).toBe(false);
      expect(listTasks()).toHaveLength(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Cloud schedule creation preserves the requesting user", async () => {
    process.env.LETTA_ACTING_USER_ID = "user-requester";
    process.env.LETTA_MANAGED_CLOUD_RUNTIME = "1";
    const requests = installScheduleApi({});

    expect(await runCronSubcommand(addArgs)).toBe(0);

    expect(
      requests.find((request) => request.method === "POST")?.actingUserId,
    ).toBe("user-requester");
  });

  test("local execution can inspect and delete legacy Cloud schedules", async () => {
    const home = mkdtempSync(join(tmpdir(), "letta-cron-legacy-cloud-"));
    process.env.LETTA_HOME = home;
    const requests = installScheduleApi({
      scheduledMessages: [legacyCloudSchedule()],
    });
    const logs: string[] = [];
    console.log = mock((line: string) => logs.push(String(line)));

    try {
      expect(
        await runCronSubcommand(["list", "--agent", "agent-cloud-test"]),
      ).toBe(0);
      expect(JSON.parse(logs.at(-1) ?? "[]")).toEqual([
        expect.objectContaining({
          id: "legacy-cloud-schedule",
          runner: "cloud",
        }),
      ]);

      expect(
        await runCronSubcommand([
          "delete",
          "legacy-cloud-schedule",
          "--agent",
          "agent-cloud-test",
        ]),
      ).toBe(0);
      expect(JSON.parse(logs.at(-1) ?? "{}")).toMatchObject({
        deleted: "legacy-cloud-schedule",
        runner: "cloud",
      });
      expect(
        requests.some(
          (request) =>
            request.method === "DELETE" &&
            request.pathname.endsWith("/legacy-cloud-schedule"),
        ),
      ).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("--runner is no longer accepted", async () => {
    const requests = installScheduleApi({});
    expect(await runCronSubcommand([...addArgs, "--runner", "cloud"])).toBe(1);
    expect(requests).toHaveLength(0);
  });

  test("managed Cloud schedule can target an explicit computer", async () => {
    process.env.LETTA_MANAGED_CLOUD_RUNTIME = "1";
    const requests = installScheduleApi({
      environments: { "device-explicit": environment("device-explicit") },
    });

    expect(
      await runCronSubcommand([...addArgs, "--computer", "device-explicit"]),
    ).toBe(0);

    expect(
      requests.find((request) => request.method === "POST")?.body,
    ).toMatchObject({ target_device_id: "device-explicit" });
  });

  test("local execution rejects --computer without touching the schedule API", async () => {
    const home = mkdtempSync(join(tmpdir(), "letta-cron-target-test-"));
    process.env.LETTA_HOME = home;
    const requests = installScheduleApi({});
    try {
      expect(
        await runCronSubcommand([...addArgs, "--computer", "device-explicit"]),
      ).toBe(1);
      expect(requests).toHaveLength(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("unregistered local execution still creates a local schedule", async () => {
    const home = mkdtempSync(join(tmpdir(), "letta-cron-local-test-"));
    process.env.LETTA_HOME = home;
    process.env.LETTA_RUNTIME_ENVIRONMENT_DEVICE_ID = "unregistered-device";
    const requests = installScheduleApi({});
    const logs: string[] = [];
    console.log = mock((line: string) => logs.push(String(line)));

    try {
      expect(await runCronSubcommand(addArgs)).toBe(0);
      expect(requests).toHaveLength(0);
      expect(JSON.parse(logs.join(""))).toMatchObject({ runner: "local" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
