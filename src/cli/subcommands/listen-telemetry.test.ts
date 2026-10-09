import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { runListenSubcommand } from "@/cli/subcommands/listen";
import { settingsManager } from "@/settings-manager";
import { telemetry } from "@/telemetry";
import { __listenerAuthTestUtils } from "@/websocket/listener/auth";

type TelemetryTestState = {
  events: unknown[];
  sessionEndTracked: boolean;
};

const telemetryState = telemetry as unknown as TelemetryTestState;

describe("listen subcommand telemetry", () => {
  const originalLoadLocalProjectSettings =
    settingsManager.loadLocalProjectSettings;
  const originalSetListenerEnvName = settingsManager.setListenerEnvName;
  const originalGetOrCreateDeviceId = settingsManager.getOrCreateDeviceId;
  const originalGetSettingsWithSecureTokens =
    settingsManager.getSettingsWithSecureTokens;
  const originalInitialize = settingsManager.initialize;
  const originalApiKey = process.env.LETTA_API_KEY;
  const originalBaseUrl = process.env.LETTA_BASE_URL;
  const originalDebug = process.env.LETTA_DEBUG;
  const originalDesktopDebugPanel = process.env.LETTA_DESKTOP_MODE;
  const originalRestoreEnabledChannels =
    process.env.LETTA_RESTORE_ENABLED_CHANNELS;
  const originalRestoreChannelAgentScope =
    process.env.LETTA_RESTORE_CHANNEL_AGENT_SCOPE;
  const originalRestoreEnabledChannelsAgentScope =
    process.env.LETTA_RESTORE_ENABLED_CHANNELS_AGENT_SCOPE;
  const originalIgnoreSelfHostedListenerError =
    process.env.IGNORE_SELF_HOSTED_LISTENER_ERROR;

  const originalTrackSessionEnd = telemetry.trackSessionEnd;
  const originalFlush = telemetry.flush;

  beforeEach(() => {
    telemetry.cleanup();
    telemetryState.events = [];
    telemetryState.sessionEndTracked = false;
    delete process.env.LETTA_API_KEY;
    delete process.env.LETTA_BASE_URL;
    process.env.LETTA_DEBUG = "0";
    delete process.env.LETTA_DESKTOP_MODE;
    delete process.env.LETTA_RESTORE_ENABLED_CHANNELS;
    delete process.env.LETTA_RESTORE_CHANNEL_AGENT_SCOPE;
    delete process.env.LETTA_RESTORE_ENABLED_CHANNELS_AGENT_SCOPE;
    delete process.env.IGNORE_SELF_HOSTED_LISTENER_ERROR;
    __listenerAuthTestUtils.setOAuthDepsForTests({
      LETTA_CLOUD_API_URL: "https://api.letta.com",
    });

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

    if (originalApiKey === undefined) {
      delete process.env.LETTA_API_KEY;
    } else {
      process.env.LETTA_API_KEY = originalApiKey;
    }
    if (originalBaseUrl === undefined) {
      delete process.env.LETTA_BASE_URL;
    } else {
      process.env.LETTA_BASE_URL = originalBaseUrl;
    }
    if (originalDebug === undefined) {
      delete process.env.LETTA_DEBUG;
    } else {
      process.env.LETTA_DEBUG = originalDebug;
    }
    if (originalDesktopDebugPanel === undefined) {
      delete process.env.LETTA_DESKTOP_MODE;
    } else {
      process.env.LETTA_DESKTOP_MODE = originalDesktopDebugPanel;
    }
    if (originalRestoreEnabledChannels === undefined) {
      delete process.env.LETTA_RESTORE_ENABLED_CHANNELS;
    } else {
      process.env.LETTA_RESTORE_ENABLED_CHANNELS =
        originalRestoreEnabledChannels;
    }
    if (originalRestoreChannelAgentScope === undefined) {
      delete process.env.LETTA_RESTORE_CHANNEL_AGENT_SCOPE;
    } else {
      process.env.LETTA_RESTORE_CHANNEL_AGENT_SCOPE =
        originalRestoreChannelAgentScope;
    }
    if (originalRestoreEnabledChannelsAgentScope === undefined) {
      delete process.env.LETTA_RESTORE_ENABLED_CHANNELS_AGENT_SCOPE;
    } else {
      process.env.LETTA_RESTORE_ENABLED_CHANNELS_AGENT_SCOPE =
        originalRestoreEnabledChannelsAgentScope;
    }
    if (originalIgnoreSelfHostedListenerError === undefined) {
      delete process.env.IGNORE_SELF_HOSTED_LISTENER_ERROR;
    } else {
      process.env.IGNORE_SELF_HOSTED_LISTENER_ERROR =
        originalIgnoreSelfHostedListenerError;
    }

    __listenerAuthTestUtils.setOAuthDepsForTests(null);
    telemetry.trackSessionEnd = originalTrackSessionEnd;
    telemetry.flush = originalFlush;
  });

  test("tracks and flushes session end for unsupported self-hosted listener startup", async () => {
    const trackSessionEndMock = mock(() => {});
    const flushMock = mock(async () => {});
    telemetry.trackSessionEnd =
      trackSessionEndMock as typeof telemetry.trackSessionEnd;
    telemetry.flush = flushMock as typeof telemetry.flush;
    process.env.LETTA_BASE_URL = "https://self-hosted.example.com";

    const exitCode = await runListenSubcommand(["--computer-name", "ci-env"]);

    expect(exitCode).toBe(1);
    expect(trackSessionEndMock).toHaveBeenCalledWith(
      undefined,
      "listener_self_hosted_no_channels",
    );
    expect(flushMock).toHaveBeenCalledTimes(1);
  });

  test("reports signed-out lifecycle state without starting browser auth", async () => {
    const lines: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = mock((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    const openInBrowser = mock(() => {});
    __listenerAuthTestUtils.setOAuthDepsForTests({
      LETTA_CLOUD_API_URL: "https://api.letta.com",
      openInBrowser,
    });

    try {
      const exitCode = await runListenSubcommand([
        "--computer-name",
        "ci-env",
        "--lifecycle-output=jsonl",
      ]);

      expect(exitCode).toBe(1);
      expect(lines.join("")).toBe(
        '{"lettaLifecycleProtocol":1,"state":"signed_out"}\n',
      );
      expect(openInBrowser).not.toHaveBeenCalled();
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  test("opens browser auth only when lifecycle sign-in is explicit", async () => {
    const lines: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = mock((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    const openInBrowser = mock(() => {});
    __listenerAuthTestUtils.setOAuthDepsForTests({
      LETTA_CLOUD_API_URL: "https://api.letta.com",
      openInBrowser,
      requestDeviceCode: mock(async () => ({
        device_code: "device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://app.letta.com/device",
        verification_uri_complete: "https://app.letta.com/device?code=ABCD",
        expires_in: 600,
        interval: 1,
      })),
      pollForToken: mock(async () => {
        throw new Error("sign-in cancelled");
      }),
    });

    try {
      const exitCode = await runListenSubcommand([
        "--computer-name",
        "ci-env",
        "--lifecycle-output=jsonl",
        "--interactive-auth",
      ]);

      expect(exitCode).toBe(1);
      expect(openInBrowser).toHaveBeenCalledWith(
        "https://app.letta.com/device?code=ABCD",
      );
      expect(lines.join("")).toBe(
        '{"lettaLifecycleProtocol":1,"state":"error"}\n',
      );
    } finally {
      process.stdout.write = originalWrite;
    }
  });
});
