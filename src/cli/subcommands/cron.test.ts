import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfiguredBackendMode } from "@/backend/backend-mode";
import { runCronSubcommand } from "@/cli/subcommands/cron";
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installScheduleApi(options: {
  environments?: Record<string, ReturnType<typeof environment>>;
}) {
  const requests: Array<{
    method: string;
    pathname: string;
    body: Record<string, unknown> | undefined;
  }> = [];

  globalThis.fetch = mock(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    requests.push({ method, pathname: url.pathname, body });

    if (
      method === "GET" &&
      url.pathname === "/v1/agents/agent-cloud-test/schedule"
    ) {
      return jsonResponse({ scheduled_messages: [], has_next_page: false });
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
    ["LETTA_HOME", originalLettaHome],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("cron add execution targeting", () => {
  test("default Cloud creation targets the current registered listener at the HTTP boundary", async () => {
    const requests = installScheduleApi({
      environments: { "device-persisted": environment("device-persisted") },
    });

    expect(await runCronSubcommand(addArgs)).toBe(0);

    expect(requests.find((request) => request.method === "POST")?.body).toEqual(
      {
        name: "boundary-test",
        description: "exercise schedule creation",
        conversation_id: "conversation-test",
        messages: [{ role: "user", content: "do the scheduled work" }],
        schedule: { type: "recurring", cron_expression: "*/5 * * * *" },
        target_device_id: "device-persisted",
        use_sandbox: true,
      },
    );
  });

  test("runtime identity override wins over the persisted installation id", async () => {
    process.env.LETTA_RUNTIME_ENVIRONMENT_DEVICE_ID = "device-runtime";
    const requests = installScheduleApi({
      environments: { "device-runtime": environment("device-runtime") },
    });

    expect(await runCronSubcommand(addArgs)).toBe(0);

    expect(
      requests.some(
        (request) => request.pathname === "/v1/environments/device-persisted",
      ),
    ).toBe(false);
    expect(
      requests.find((request) => request.method === "POST")?.body,
    ).toMatchObject({ target_device_id: "device-runtime" });
  });

  test("default Cloud creation from a managed sandbox falls through to an untargeted schedule", async () => {
    process.env.LETTA_RUNTIME_ENVIRONMENT_DEVICE_ID = "sandbox-agent-example";
    const requests = installScheduleApi({});

    expect(await runCronSubcommand(addArgs)).toBe(0);

    // No environments lookup: the sandbox check resolves before registry validation.
    expect(
      requests.some((request) =>
        request.pathname.startsWith("/v1/environments/"),
      ),
    ).toBe(false);
    const body = requests.find((request) => request.method === "POST")?.body;
    expect(body).toEqual({
      name: "boundary-test",
      description: "exercise schedule creation",
      conversation_id: "conversation-test",
      messages: [{ role: "user", content: "do the scheduled work" }],
      schedule: { type: "recurring", cron_expression: "*/5 * * * *" },
      use_sandbox: true,
    });
  });

  test("explicit --runner cloud deliberately omits inferred targeting", async () => {
    process.env.LETTA_RUNTIME_ENVIRONMENT_DEVICE_ID = "sandbox-agent-example";
    const requests = installScheduleApi({});

    expect(await runCronSubcommand([...addArgs, "--runner", "cloud"])).toBe(0);

    expect(
      requests.some((request) =>
        request.pathname.startsWith("/v1/environments/"),
      ),
    ).toBe(false);
    const body = requests.find((request) => request.method === "POST")?.body;
    expect(body).toEqual({
      name: "boundary-test",
      description: "exercise schedule creation",
      conversation_id: "conversation-test",
      messages: [{ role: "user", content: "do the scheduled work" }],
      schedule: { type: "recurring", cron_expression: "*/5 * * * *" },
      use_sandbox: true,
    });
  });

  test("explicit --computer wins over --runner cloud and runtime inference", async () => {
    process.env.LETTA_RUNTIME_ENVIRONMENT_DEVICE_ID = "sandbox-agent-example";
    const requests = installScheduleApi({
      environments: { "device-explicit": environment("device-explicit") },
    });

    expect(
      await runCronSubcommand([
        ...addArgs,
        "--runner",
        "cloud",
        "--computer",
        "device-explicit",
      ]),
    ).toBe(0);

    expect(
      requests.find((request) => request.method === "POST")?.body,
    ).toMatchObject({ target_device_id: "device-explicit" });
  });

  test("--runner local rejects --computer without touching the schedule API", async () => {
    const home = mkdtempSync(join(tmpdir(), "letta-cron-target-test-"));
    process.env.LETTA_HOME = home;
    const requests = installScheduleApi({});
    try {
      expect(
        await runCronSubcommand([
          ...addArgs,
          "--runner",
          "local",
          "--computer",
          "device-explicit",
        ]),
      ).toBe(1);
      expect(requests).toHaveLength(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("default creation on an unregistered runtime falls back to a local schedule with a warning", async () => {
    const home = mkdtempSync(join(tmpdir(), "letta-cron-fallback-test-"));
    process.env.LETTA_HOME = home;
    const requests = installScheduleApi({});
    const logs: string[] = [];
    console.log = mock((line: string) => {
      logs.push(String(line));
    });

    try {
      expect(await runCronSubcommand(addArgs)).toBe(0);

      // No Cloud schedule was created.
      expect(requests.some((request) => request.method === "POST")).toBe(false);

      const output = JSON.parse(logs.join("")) as Record<string, unknown>;
      expect(output.runner).toBe("local");
      // addArgs uses --every (recurring), so the warning carries both the
      // fallback reason and the louder recurring durability caution.
      expect(String(output.warning)).toContain(
        "This schedule is local to this computer",
      );
      expect(String(output.warning)).toContain("Recurring schedules");
      expect(String(output.warning)).toContain("--runner cloud");
      expect(String(output.warning)).toContain("--computer <deviceId>");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("one-shot fallback warning omits the recurring caution", async () => {
    const home = mkdtempSync(join(tmpdir(), "letta-cron-fallback-once-"));
    process.env.LETTA_HOME = home;
    installScheduleApi({});
    const logs: string[] = [];
    console.log = mock((line: string) => {
      logs.push(String(line));
    });

    const everyIndex = addArgs.indexOf("--every");
    const oneShotArgs = [...addArgs];
    oneShotArgs.splice(everyIndex, 2, "--at", "in 30m");

    try {
      expect(await runCronSubcommand(oneShotArgs)).toBe(0);

      const output = JSON.parse(logs.join("")) as Record<string, unknown>;
      expect(output.runner).toBe("local");
      expect(String(output.warning)).toContain(
        "This schedule is local to this computer",
      );
      expect(String(output.warning)).not.toContain("Recurring schedules");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
