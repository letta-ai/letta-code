import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { listTasks } from "@/cron";
import { type Settings, settingsManager } from "@/settings-manager";
import { runCronSubcommand } from "./cron";

type RecordedRequest = {
  method: string;
  path: string;
  body?: Record<string, unknown>;
};

const TEST_DIR = join(import.meta.dir, "__cron_command_test_tmp__");
const originalInitialize = settingsManager.initialize;
const originalGetSettingsWithSecureTokens =
  settingsManager.getSettingsWithSecureTokens;
const originalGetOrCreateDeviceId = settingsManager.getOrCreateDeviceId;
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalEnvironment = {
  baseUrl: process.env.LETTA_BASE_URL,
  apiKey: process.env.LETTA_API_KEY,
  runtimeDeviceId: process.env.LETTA_RUNTIME_ENVIRONMENT_DEVICE_ID,
  lettaHome: process.env.LETTA_HOME,
  localBackend: process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL,
};

let server: Server;
let baseUrl = "";
let persistedDeviceId = "device-persisted";
let scheduleCapabilityStatus = 200;
let environmentLookupStatus: number | null = null;
let requests: RecordedRequest[] = [];
let errors: string[] = [];
const environments = new Map<string, { organizationId: string } | null>();

function sendJson(
  response: import("node:http").ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

function addArgs(...extra: string[]): string[] {
  return [
    "add",
    "--name",
    "integration-task",
    "--description",
    "integration schedule",
    "--prompt",
    "do the thing",
    "--cron",
    "*/5 * * * *",
    "--agent",
    "agent-test",
    ...extra,
  ];
}

function schedulePosts(): RecordedRequest[] {
  return requests.filter(
    (request) =>
      request.method === "POST" &&
      request.path === "/v1/agents/agent-test/schedule",
  );
}

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", baseUrl);
    let body: Record<string, unknown> | undefined;
    if (request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
        string,
        unknown
      >;
    }
    requests.push({
      method: request.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      ...(body && { body }),
    });

    if (
      request.method === "GET" &&
      url.pathname === "/v1/agents/agent-test/schedule"
    ) {
      if (scheduleCapabilityStatus !== 200) {
        sendJson(response, scheduleCapabilityStatus, {
          error: "schedule route unavailable",
        });
        return;
      }
      sendJson(response, 200, {
        scheduled_messages: [],
        has_next_page: false,
      });
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname.startsWith("/v1/environments/")
    ) {
      if (environmentLookupStatus !== null) {
        sendJson(response, environmentLookupStatus, {
          error: "environment lookup failed",
        });
        return;
      }
      const deviceId = decodeURIComponent(
        url.pathname.slice("/v1/environments/".length),
      );
      const environment = environments.get(deviceId);
      if (!environment) {
        sendJson(response, 404, { error: "environment not found" });
        return;
      }
      sendJson(response, 200, {
        id: `environment-${deviceId}`,
        deviceId,
        organizationId: environment.organizationId,
      });
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/v1/agents/agent-test/schedule" &&
      body
    ) {
      sendJson(response, 200, {
        id: "schedule-created",
        use_sandbox: true,
        target_device_id: body.target_device_id ?? null,
      });
      return;
    }

    sendJson(response, 404, { error: "unexpected request" });
  });

  baseUrl = await new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("test server did not bind a TCP port"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  settingsManager.initialize = async () => {};
  settingsManager.getSettingsWithSecureTokens = async () =>
    ({ env: {} }) as Settings;
  settingsManager.getOrCreateDeviceId = () => persistedDeviceId;
  console.log = () => {};
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
});

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.LETTA_HOME = TEST_DIR;
  process.env.LETTA_BASE_URL = baseUrl;
  process.env.LETTA_API_KEY = "test-api-key";
  delete process.env.LETTA_RUNTIME_ENVIRONMENT_DEVICE_ID;
  delete process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
  persistedDeviceId = "device-persisted";
  scheduleCapabilityStatus = 200;
  environmentLookupStatus = null;
  requests = [];
  errors = [];
  environments.clear();
});

afterAll(async () => {
  settingsManager.initialize = originalInitialize;
  settingsManager.getSettingsWithSecureTokens =
    originalGetSettingsWithSecureTokens;
  settingsManager.getOrCreateDeviceId = originalGetOrCreateDeviceId;
  console.log = originalConsoleLog;
  console.error = originalConsoleError;

  for (const [key, value] of Object.entries(originalEnvironment)) {
    const environmentKey =
      key === "baseUrl"
        ? "LETTA_BASE_URL"
        : key === "apiKey"
          ? "LETTA_API_KEY"
          : key === "runtimeDeviceId"
            ? "LETTA_RUNTIME_ENVIRONMENT_DEVICE_ID"
            : key === "lettaHome"
              ? "LETTA_HOME"
              : "LETTA_LOCAL_BACKEND_EXPERIMENTAL";
    if (value === undefined) delete process.env[environmentKey];
    else process.env[environmentKey] = value;
  }
  rmSync(TEST_DIR, { recursive: true, force: true });
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("runCronSubcommand add schedule creation", () => {
  test("targets the registered persisted listener by default", async () => {
    environments.set("device-persisted", { organizationId: "org-test" });

    expect(await runCronSubcommand(addArgs())).toBe(0);

    expect(
      requests.map((request) => `${request.method} ${request.path}`),
    ).toEqual([
      "GET /v1/agents/agent-test/schedule?limit=1",
      "GET /v1/environments/device-persisted",
      "POST /v1/agents/agent-test/schedule",
    ]);
    expect(schedulePosts()[0]?.body).toMatchObject({
      use_sandbox: true,
      target_device_id: "device-persisted",
    });
  });

  test("prefers the runtime execution device override", async () => {
    process.env.LETTA_RUNTIME_ENVIRONMENT_DEVICE_ID = "device-runtime";
    environments.set("device-runtime", { organizationId: "org-test" });

    expect(await runCronSubcommand(addArgs())).toBe(0);

    expect(requests.map((request) => request.path)).toContain(
      "/v1/environments/device-runtime",
    );
    expect(requests.map((request) => request.path)).not.toContain(
      "/v1/environments/device-persisted",
    );
    expect(schedulePosts()[0]?.body).toMatchObject({
      use_sandbox: true,
      target_device_id: "device-runtime",
    });
  });

  test("explicit cloud runner creates an untargeted managed-sandbox schedule", async () => {
    expect(await runCronSubcommand(addArgs("--runner", "cloud"))).toBe(0);

    expect(
      requests.map((request) => `${request.method} ${request.path}`),
    ).toEqual([
      "GET /v1/agents/agent-test/schedule?limit=1",
      "POST /v1/agents/agent-test/schedule",
    ]);
    expect(schedulePosts()[0]?.body).toMatchObject({ use_sandbox: true });
    expect(schedulePosts()[0]?.body).not.toHaveProperty("target_device_id");
  });

  test("explicit computer is verified and targeted", async () => {
    environments.set("device-explicit", { organizationId: "org-test" });

    expect(
      await runCronSubcommand(addArgs("--computer", "device-explicit")),
    ).toBe(0);

    expect(requests.map((request) => request.path)).toContain(
      "/v1/environments/device-explicit",
    );
    expect(schedulePosts()[0]?.body).toMatchObject({
      use_sandbox: true,
      target_device_id: "device-explicit",
    });
  });

  test("local runner creates only the local file schedule", async () => {
    expect(await runCronSubcommand(addArgs("--runner", "local"))).toBe(0);

    expect(requests).toEqual([]);
    expect(listTasks()).toHaveLength(1);
    expect(existsSync(join(TEST_DIR, "crons.json"))).toBe(true);
  });

  test("local runner rejects an explicit computer without inference", async () => {
    expect(
      await runCronSubcommand(
        addArgs("--runner", "local", "--computer", "device-explicit"),
      ),
    ).toBe(1);

    expect(requests).toEqual([]);
    expect(listTasks()).toEqual([]);
    expect(errors.join("\n")).toContain("--computer requires the cloud runner");
  });

  test("missing Cloud schedule routes fail without creating a local task", async () => {
    scheduleCapabilityStatus = 404;

    expect(await runCronSubcommand(addArgs())).toBe(1);

    expect(
      requests.map((request) => `${request.method} ${request.path}`),
    ).toEqual(["GET /v1/agents/agent-test/schedule?limit=1"]);
    expect(schedulePosts()).toEqual([]);
    expect(listTasks()).toEqual([]);
    expect(existsSync(join(TEST_DIR, "crons.json"))).toBe(false);
    expect(errors.join("\n")).toContain("--runner local");
    expect(errors.join("\n")).toContain("durable Cloud schedules");
  });

  test("unregistered default device fails before schedule creation", async () => {
    expect(await runCronSubcommand(addArgs())).toBe(1);

    expect(
      requests.map((request) => `${request.method} ${request.path}`),
    ).toEqual([
      "GET /v1/agents/agent-test/schedule?limit=1",
      "GET /v1/environments/device-persisted",
    ]);
    expect(schedulePosts()).toEqual([]);
    expect(errors.join("\n")).toContain("--runner cloud");
    expect(errors.join("\n")).toContain("--computer <id>");
    expect(errors.join("\n")).toContain("--runner local");
  });

  test("non-404 computer verification failure is not called unregistered", async () => {
    environmentLookupStatus = 500;

    expect(await runCronSubcommand(addArgs())).toBe(1);

    expect(
      requests.map((request) => `${request.method} ${request.path}`),
    ).toEqual([
      "GET /v1/agents/agent-test/schedule?limit=1",
      "GET /v1/environments/device-persisted",
    ]);
    expect(schedulePosts()).toEqual([]);
    expect(errors.join("\n")).toContain("Could not verify computer");
    expect(errors.join("\n")).toContain("server returned 500");
    expect(errors.join("\n")).not.toContain("not registered");
    expect(errors.join("\n")).toContain("--runner cloud");
    expect(errors.join("\n")).toContain("--computer <id>");
    expect(errors.join("\n")).toContain("--runner local");
  });

  test("desktop-local-only default device fails before schedule creation", async () => {
    environments.set("device-persisted", { organizationId: "local" });

    expect(await runCronSubcommand(addArgs())).toBe(1);

    expect(requests.map((request) => request.path)).toContain(
      "/v1/environments/device-persisted",
    );
    expect(schedulePosts()).toEqual([]);
    expect(errors.join("\n")).toContain("local desktop connection");
  });
});
