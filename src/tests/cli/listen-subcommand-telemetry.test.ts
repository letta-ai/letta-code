import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { runListenSubcommand } from "../../cli/subcommands/listen";
import { settingsManager } from "../../settings-manager";
import { telemetry } from "../../telemetry";

describe("listen subcommand telemetry", () => {
  const originalLoadLocalProjectSettings =
    settingsManager.loadLocalProjectSettings;
  const originalSetListenerEnvName = settingsManager.setListenerEnvName;
  const originalGetOrCreateDeviceId = settingsManager.getOrCreateDeviceId;
  const originalGetSettingsWithSecureTokens =
    settingsManager.getSettingsWithSecureTokens;
  const originalInitialize = settingsManager.initialize;
  const originalBaseUrl = process.env.LETTA_BASE_URL;

  const originalTrackSessionEnd = telemetry.trackSessionEnd;
  const originalFlush = telemetry.flush;

  beforeEach(() => {
    telemetry.cleanup();
    delete process.env.LETTA_API_KEY;
    delete process.env.LETTA_BASE_URL;

    settingsManager.loadLocalProjectSettings = mock(async () => ({
      lastAgent: null,
    })) as unknown as typeof settingsManager.loadLocalProjectSettings;
    settingsManager.setListenerEnvName = mock(
      () => {},
    ) as typeof settingsManager.setListenerEnvName;
    settingsManager.initialize = mock(
      async () => {},
    ) as typeof settingsManager.initialize;
    settingsManager.getOrCreateDeviceId = mock(
      () => "device-test",
    ) as typeof settingsManager.getOrCreateDeviceId;
    settingsManager.getSettingsWithSecureTokens = mock(async () => ({
      env: {},
    })) as unknown as typeof settingsManager.getSettingsWithSecureTokens;
  });

  afterEach(() => {
    settingsManager.loadLocalProjectSettings = originalLoadLocalProjectSettings;
    settingsManager.setListenerEnvName = originalSetListenerEnvName;
    settingsManager.initialize = originalInitialize;
    settingsManager.getOrCreateDeviceId = originalGetOrCreateDeviceId;
    settingsManager.getSettingsWithSecureTokens =
      originalGetSettingsWithSecureTokens;

    if (originalBaseUrl === undefined) {
      delete process.env.LETTA_BASE_URL;
    } else {
      process.env.LETTA_BASE_URL = originalBaseUrl;
    }

    telemetry.trackSessionEnd = originalTrackSessionEnd;
    telemetry.flush = originalFlush;
  });

  test("tracks and flushes session end on missing API key", async () => {
    const trackSessionEndMock = mock(() => {});
    const flushMock = mock(async () => {});
    telemetry.trackSessionEnd =
      trackSessionEndMock as typeof telemetry.trackSessionEnd;
    telemetry.flush = flushMock as typeof telemetry.flush;
    process.env.LETTA_BASE_URL = "https://self-hosted.example.com";

    const exitCode = await runListenSubcommand(["--env-name", "ci-env"]);

    expect(exitCode).toBe(1);
    expect(trackSessionEndMock).toHaveBeenCalledWith(
      undefined,
      "listener_missing_api_key",
    );
    expect(flushMock).toHaveBeenCalledTimes(1);
  });
});
