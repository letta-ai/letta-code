import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { settingsManager } from "@/settings-manager";
import { telemetry } from "@/telemetry";

type TelemetryTestState = {
  events: unknown[];
  messageCount: number;
  currentAgentId: string | null;
  surface: "tui" | "headless" | "websocket";
  sessionEndTracked: boolean;
  isCloudUser: () => boolean;
};

const telemetryState = telemetry as unknown as TelemetryTestState;

describe("telemetry flush auth", () => {
  const originalFetch = globalThis.fetch;
  const originalGetSettingsWithSecureTokens =
    settingsManager.getSettingsWithSecureTokens;
  const originalGetSettings = settingsManager.getSettings;
  const originalIsCloudUser = telemetryState.isCloudUser;
  const originalLettaApiKey = process.env.LETTA_API_KEY;
  const originalTelemetryDisabled = process.env.LETTA_TELEMETRY_DISABLED;
  const originalLettaBaseUrl = process.env.LETTA_BASE_URL;

  function deleteEnvVarCaseInsensitive(name: string): void {
    const normalized = name.toLowerCase();
    for (const key of Object.keys(process.env)) {
      if (key.toLowerCase() === normalized) {
        delete process.env[key];
      }
    }
  }

  function setEnvVar(name: string, value: string): void {
    deleteEnvVarCaseInsensitive(name);
    process.env[name] = value;
  }

  function restoreEnvVar(name: string, value: string | undefined): void {
    if (value === undefined) {
      deleteEnvVarCaseInsensitive(name);
      return;
    }

    setEnvVar(name, value);
  }

  beforeEach(() => {
    telemetry.cleanup();
    telemetryState.events = [];
    telemetryState.messageCount = 0;
    telemetryState.currentAgentId = null;
    telemetryState.surface = "tui";
    telemetryState.sessionEndTracked = false;
    deleteEnvVarCaseInsensitive("LETTA_API_KEY");
    deleteEnvVarCaseInsensitive("LETTA_TELEMETRY_DISABLED");
    deleteEnvVarCaseInsensitive("LETTA_BASE_URL");
    settingsManager.getSettings = mock(() => ({
      env: {},
    })) as unknown as typeof settingsManager.getSettings;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    settingsManager.getSettingsWithSecureTokens =
      originalGetSettingsWithSecureTokens;
    settingsManager.getSettings = originalGetSettings;
    telemetryState.isCloudUser = originalIsCloudUser;
    restoreEnvVar("LETTA_API_KEY", originalLettaApiKey);
    restoreEnvVar("LETTA_TELEMETRY_DISABLED", originalTelemetryDisabled);
    restoreEnvVar("LETTA_BASE_URL", originalLettaBaseUrl);
  });

  test("flush falls back to secure settings token when env var is absent", async () => {
    const fetchMock = mock(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer settings-key",
        });
        return new Response(null, { status: 200 });
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    settingsManager.getSettingsWithSecureTokens = mock(async () => ({
      env: {
        LETTA_API_KEY: "settings-key",
      },
    })) as unknown as typeof settingsManager.getSettingsWithSecureTokens;

    telemetry.trackUserInput("hello", "user", "model-1");
    await telemetry.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("self-hosted users do not send error telemetry", async () => {
    // Avoid process.env races with unrelated test files on Windows, where env
    // keys are case-insensitive but not isolated across the full Bun run.
    telemetryState.isCloudUser = () => false;

    const fetchMock = mock(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    settingsManager.getSettingsWithSecureTokens = mock(async () => ({
      env: {
        LETTA_API_KEY: "settings-key",
      },
    })) as unknown as typeof settingsManager.getSettingsWithSecureTokens;

    telemetry.trackError("test_error", "test message", "test_context");
    expect(telemetryState.events).toHaveLength(0);
  });

  test("self-hosted users still send usage telemetry", async () => {
    setEnvVar("LETTA_BASE_URL", "http://localhost:8283");

    const fetchMock = mock(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    settingsManager.getSettingsWithSecureTokens = mock(async () => ({
      env: {
        LETTA_API_KEY: "settings-key",
      },
    })) as unknown as typeof settingsManager.getSettingsWithSecureTokens;

    telemetry.trackUserInput("hello", "user", "model-1");
    await telemetry.flush();

    expect(telemetryState.events).toHaveLength(0); // flushed successfully
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("flush prefers env token over secure settings token", async () => {
    setEnvVar("LETTA_API_KEY", "env-key");

    const fetchMock = mock(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer env-key",
        });
        return new Response(null, { status: 200 });
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    settingsManager.getSettingsWithSecureTokens = mock(async () => ({
      env: {
        LETTA_API_KEY: "settings-key",
      },
    })) as unknown as typeof settingsManager.getSettingsWithSecureTokens;

    telemetry.trackUserInput("hello", "user", "model-1");
    await telemetry.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
