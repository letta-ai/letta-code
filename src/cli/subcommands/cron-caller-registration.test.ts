import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { setConfiguredBackendMode } from "@/backend/backend-mode";
import { runCronSubcommand } from "@/cli/subcommands/cron";
import { runWithRuntimeContext } from "@/runtime-context";
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

function environment(
  deviceId: string,
  overrides: {
    connectionName?: string;
    connectionId?: string | null;
    lastHeartbeat?: number | null;
  } = {},
) {
  const now = Date.now();
  return {
    id: `environment-${deviceId}`,
    connectionId: `connection-${deviceId}`,
    deviceId,
    connectionName: "external listener",
    organizationId: "org-test",
    podId: null as string | null,
    connectedAt: now,
    lastHeartbeat: now as number | null,
    lastSeenAt: now,
    firstSeenAt: now,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installScheduleApi(
  environments: Record<string, ReturnType<typeof environment>>,
) {
  const methods: string[] = [];
  globalThis.fetch = mock(async (input, init) => {
    const pathname = new URL(String(input)).pathname;
    methods.push(init?.method ?? "GET");
    if (pathname === "/v1/agents/agent-cloud-test/schedule") {
      return jsonResponse({ scheduled_messages: [], has_next_page: false });
    }
    if (pathname === "/v1/environments") {
      return jsonResponse({
        connections: Object.values(environments),
        hasNextPage: false,
      });
    }
    const device =
      environments[decodeURIComponent(pathname.split("/").at(-1) ?? "")];
    return device ? jsonResponse(device) : jsonResponse({}, 404);
  }) as unknown as typeof fetch;
  return methods;
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

test.each([
  [undefined, "no runtime device ID"],
  ["unknown-device", "could not verify"],
  ["local-only", "could not verify"],
] as const)(
  "explicit target still requires a qualified caller (%s)",
  async (caller, diagnostic) => {
    const requests = installScheduleApi({
      target: environment("target"),
      "local-only": {
        ...environment("local-only"),
        organizationId: "local",
      },
    });
    const errors: string[] = [];
    console.error = mock((line: string) => errors.push(String(line)));
    expect(
      await runWithRuntimeContext(
        { sessionSource: "listen", environmentDeviceId: caller },
        () => runCronSubcommand([...addArgs, "--computer", "target"]),
      ),
    ).toBe(1);
    expect(errors.join("\n")).toContain(diagnostic);
    expect(requests.includes("POST")).toBe(false);
  },
);
