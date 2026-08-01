import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { runListenSubcommand } from "@/cli/subcommands/listen";
import { settingsManager } from "@/settings-manager";
import { telemetry } from "@/telemetry";
import { deriveListenerInstanceId } from "@/websocket/listen-register";
import { acquireManualListenerLock } from "@/websocket/listener/manual-instance-lock";

describe("standalone listener single-instance wiring", () => {
  const originalInitialize = settingsManager.initialize;
  const originalLoadLocalProjectSettings =
    settingsManager.loadLocalProjectSettings;
  const originalSetListenerEnvName = settingsManager.setListenerEnvName;
  const originalGetOrCreateDeviceId = settingsManager.getOrCreateDeviceId;
  const originalGetSettingsWithSecureTokens =
    settingsManager.getSettingsWithSecureTokens;
  const originalConsoleError = console.error;
  const originalConsoleLog = console.log;
  const originalHome = process.env.HOME;
  const originalApiKey = process.env.LETTA_API_KEY;
  const originalBaseUrl = process.env.LETTA_BASE_URL;
  const originalSpawnerIdentity = process.env.LETTA_LISTENER_INSTANCE_ID;
  const originalDesktopMode = process.env.LETTA_DESKTOP_MODE;
  const originalIgnoreSelfHostedListenerError =
    process.env.IGNORE_SELF_HOSTED_LISTENER_ERROR;

  let tempHome: string;
  let errors: string[];

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "letta-listener-wiring-"));
    errors = [];
    process.env.HOME = tempHome;
    process.env.LETTA_API_KEY = "test-api-key";
    delete process.env.LETTA_BASE_URL;
    delete process.env.LETTA_LISTENER_INSTANCE_ID;
    delete process.env.LETTA_DESKTOP_MODE;
    delete process.env.IGNORE_SELF_HOSTED_LISTENER_ERROR;

    settingsManager.initialize = mock(
      async () => {},
    ) as typeof settingsManager.initialize;
    settingsManager.loadLocalProjectSettings = mock(async () => ({
      lastAgent: null,
    })) as unknown as typeof settingsManager.loadLocalProjectSettings;
    settingsManager.setListenerEnvName = mock(
      () => {},
    ) as typeof settingsManager.setListenerEnvName;
    settingsManager.getOrCreateDeviceId = mock(
      () => "device-test",
    ) as typeof settingsManager.getOrCreateDeviceId;
    settingsManager.getSettingsWithSecureTokens = mock(async () => ({
      env: {},
    })) as unknown as typeof settingsManager.getSettingsWithSecureTokens;

    console.error = mock((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    }) as typeof console.error;
    console.log = mock(() => {}) as typeof console.log;
  });

  afterEach(async () => {
    settingsManager.initialize = originalInitialize;
    settingsManager.loadLocalProjectSettings = originalLoadLocalProjectSettings;
    settingsManager.setListenerEnvName = originalSetListenerEnvName;
    settingsManager.getOrCreateDeviceId = originalGetOrCreateDeviceId;
    settingsManager.getSettingsWithSecureTokens =
      originalGetSettingsWithSecureTokens;
    console.error = originalConsoleError;
    console.log = originalConsoleLog;
    telemetry.cleanup();

    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalApiKey === undefined) delete process.env.LETTA_API_KEY;
    else process.env.LETTA_API_KEY = originalApiKey;
    if (originalBaseUrl === undefined) delete process.env.LETTA_BASE_URL;
    else process.env.LETTA_BASE_URL = originalBaseUrl;
    if (originalSpawnerIdentity === undefined) {
      delete process.env.LETTA_LISTENER_INSTANCE_ID;
    } else {
      process.env.LETTA_LISTENER_INSTANCE_ID = originalSpawnerIdentity;
    }
    if (originalDesktopMode === undefined) {
      delete process.env.LETTA_DESKTOP_MODE;
    } else {
      process.env.LETTA_DESKTOP_MODE = originalDesktopMode;
    }
    if (originalIgnoreSelfHostedListenerError === undefined) {
      delete process.env.IGNORE_SELF_HOSTED_LISTENER_ERROR;
    } else {
      process.env.IGNORE_SELF_HOSTED_LISTENER_ERROR =
        originalIgnoreSelfHostedListenerError;
    }

    await rm(tempHome, { recursive: true, force: true });
  });

  function scope() {
    return {
      serverUrl: "https://api.letta.com",
      deviceId: "device-test",
      listenerInstanceId: deriveListenerInstanceId("server", "ci-env"),
    };
  }

  test("rejects a duplicate before channel adapters or Cloud registration start", async () => {
    const incumbent = await acquireManualListenerLock(scope(), {
      lockRoot: path.join(tempHome, ".letta"),
      ownerToken: "incumbent",
    });
    try {
      const exitCode = await runListenSubcommand([
        "--env-name",
        "ci-env",
        "--channels",
        "slack",
      ]);

      expect(exitCode).toBe(1);
      expect(errors.join("\n")).toContain("already running");
      expect(errors.join("\n")).toContain(`pid ${process.pid}`);
    } finally {
      await incumbent.release();
    }
  });

  test("releases ownership when startup fails after acquisition", async () => {
    const exitCode = await runListenSubcommand([
      "--env-name",
      "ci-env",
      "--channels",
      "not-a-channel",
      "--install-channel-runtimes",
    ]);
    expect(exitCode).toBe(1);

    const replacement = await acquireManualListenerLock(scope(), {
      lockRoot: path.join(tempHome, ".letta"),
      ownerToken: "replacement",
    });
    await replacement.release();
  });

  test("leaves legacy Desktop-managed children outside the manual guard", async () => {
    const incumbent = await acquireManualListenerLock(scope(), {
      lockRoot: path.join(tempHome, ".letta"),
      ownerToken: "manual-incumbent",
    });
    process.env.LETTA_DESKTOP_MODE = "1";

    try {
      const exitCode = await runListenSubcommand([
        "--env-name",
        "ci-env",
        "--channels",
        "not-a-channel",
        "--install-channel-runtimes",
      ]);

      expect(exitCode).toBe(1);
      expect(errors.join("\n")).toContain('Unknown channel "not-a-channel"');
      expect(errors.join("\n")).not.toContain("already running");
    } finally {
      await incumbent.release();
    }
  });

  test("registers with an explicitly enabled custom environment server", async () => {
    let registrationRequests = 0;
    const server = createServer((request, response) => {
      if (
        request.method === "POST" &&
        request.url === "/v1/environments/register"
      ) {
        registrationRequests++;
      }
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ message: "expected test rejection" }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    process.env.LETTA_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.IGNORE_SELF_HOSTED_LISTENER_ERROR = "1";

    try {
      const exitCode = await runListenSubcommand([
        "--env-name",
        "custom-router",
      ]);

      expect(exitCode).toBe(1);
      expect(registrationRequests).toBe(1);
      expect(errors.join("\n")).toContain("expected test rejection");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
