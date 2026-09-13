import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  __listenSubcommandTestUtils,
  runListenSubcommand,
} from "@/cli/subcommands/listen";
import { settingsManager } from "@/settings-manager";
import { telemetry } from "@/telemetry";
import { deriveListenerInstanceId } from "@/websocket/listen-register";
import { __listenerIdentityTestUtils } from "@/websocket/listener/identity";
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
  const originalSpawnerDevice = process.env.LETTA_LISTENER_DEVICE_ID;
  const originalRuntimeDevice = process.env.LETTA_RUNTIME_ENVIRONMENT_DEVICE_ID;
  const originalDebug = process.env.LETTA_DEBUG;

  let tempHome: string;
  let errors: string[];

  beforeEach(async () => {
    __listenerIdentityTestUtils.resetCachedSpawnerIdentity();
    delete process.env.LETTA_LISTENER_DEVICE_ID;
    tempHome = await mkdtemp(path.join(tmpdir(), "letta-listener-wiring-"));
    errors = [];
    process.env.HOME = tempHome;
    process.env.LETTA_API_KEY = "test-api-key";
    delete process.env.LETTA_BASE_URL;
    delete process.env.LETTA_LISTENER_INSTANCE_ID;
    delete process.env.LETTA_DESKTOP_MODE;

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
    __listenerIdentityTestUtils.resetCachedSpawnerIdentity();
    if (originalSpawnerDevice === undefined)
      delete process.env.LETTA_LISTENER_DEVICE_ID;
    else process.env.LETTA_LISTENER_DEVICE_ID = originalSpawnerDevice;
    if (originalRuntimeDevice === undefined)
      delete process.env.LETTA_RUNTIME_ENVIRONMENT_DEVICE_ID;
    else
      process.env.LETTA_RUNTIME_ENVIRONMENT_DEVICE_ID = originalRuntimeDevice;
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
    if (originalDebug === undefined) delete process.env.LETTA_DEBUG;
    else process.env.LETTA_DEBUG = originalDebug;

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

  test("leaves legacy Desktop-managed children outside the manual guard", () => {
    process.env.LETTA_DESKTOP_MODE = "1";

    expect(
      __listenSubcommandTestUtils.shouldAcquireStandaloneListenerLock(),
    ).toBe(false);
  });

  test("uses Desktop registration identity without writing CLI device or name", async () => {
    process.env.LETTA_LISTENER_DEVICE_ID = "desktop:install-1:user-1";
    process.env.LETTA_LISTENER_INSTANCE_ID = "desktop-primary:install-1";
    const exitCode = await runListenSubcommand([
      "--env-name",
      "My Desktop",
      "--channels",
      "not-a-channel",
      "--install-channel-runtimes",
    ]);
    // Stop at the existing channel validation boundary, before connecting to Cloud.
    expect(exitCode).toBe(1);
    expect(settingsManager.getOrCreateDeviceId).not.toHaveBeenCalled();
    expect(settingsManager.setListenerEnvName).not.toHaveBeenCalled();
    expect(process.env.LETTA_RUNTIME_ENVIRONMENT_DEVICE_ID).toBe(
      "desktop:install-1:user-1",
    );
    expect(process.env.LETTA_LISTENER_DEVICE_ID).toBeUndefined();
  });

  test("enables shared debug logging in --debug mode", async () => {
    process.env.LETTA_DEBUG = "0";

    expect(await runListenSubcommand(["--debug", "--help"])).toBe(0);
    expect(process.env.LETTA_DEBUG).toBe("1");
  });
});
