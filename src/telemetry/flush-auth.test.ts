import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { settingsManager } from "@/settings-manager";
import {
  getListenerTelemetrySurface,
  getTerminalTelemetrySurface,
  resolveTelemetryBackend,
  type TelemetryBackend,
  type TelemetrySurface,
  telemetry,
} from "@/telemetry";

type TelemetryTestState = {
  events: unknown[];
  messageCount: number;
  currentAgentId: string | null;
  surface: TelemetrySurface;
  sessionEndTracked: boolean;
  isCloudUser: () => boolean;
};

const telemetryState = telemetry as unknown as TelemetryTestState;

const telemetrySurfaces = [
  "letta_code_tui",
  "letta_code_headless",
  "letta_code_cli_server",
  "letta_code_desktop",
] satisfies TelemetrySurface[];

const telemetryBackends = [
  "constellation",
  "local",
  "docker_deprecated",
  "self_hosted_api",
  "unknown",
] satisfies TelemetryBackend[];

describe("telemetry segmentation", () => {
  test("maps surfaces to stable analytics buckets", () => {
    expect(getTerminalTelemetrySurface(false)).toBe("letta_code_tui");
    expect(getTerminalTelemetrySurface(true)).toBe("letta_code_headless");
    expect(getListenerTelemetrySurface({})).toBe("letta_code_cli_server");
    expect(getListenerTelemetrySurface({ LETTA_DESKTOP_MODE: "1" })).toBe(
      "letta_code_desktop",
    );
  });

  test("maps backends to stable analytics buckets", () => {
    expect(
      resolveTelemetryBackend({
        env: { LETTA_LOCAL_BACKEND_EXPERIMENTAL: "1" },
        serverUrl: "https://api.letta.com",
      }),
    ).toBe("local");
    expect(
      resolveTelemetryBackend({ env: {}, serverUrl: "https://api.letta.com" }),
    ).toBe("constellation");
    expect(
      resolveTelemetryBackend({
        env: { LETTA_DESKTOP_MODE: "1" },
        serverUrl: "http://127.0.0.1:54085",
      }),
    ).toBe("constellation");
    expect(
      resolveTelemetryBackend({ env: {}, serverUrl: "http://localhost:8283" }),
    ).toBe("docker_deprecated");
    expect(
      resolveTelemetryBackend({
        env: {},
        serverUrl: "https://self-hosted.example.com",
      }),
    ).toBe("self_hosted_api");
    expect(resolveTelemetryBackend({ env: {}, serverUrl: null })).toBe(
      "unknown",
    );
  });
});

describe("telemetry flush auth", () => {
  const originalFetch = globalThis.fetch;
  const originalGetSettingsWithSecureTokens =
    settingsManager.getSettingsWithSecureTokens;
  const originalGetSettings = settingsManager.getSettings;
  const originalIsCloudUser = telemetryState.isCloudUser;
  const originalLettaApiKey = process.env.LETTA_API_KEY;
  const originalTelemetryDisabled = process.env.LETTA_TELEMETRY_DISABLED;
  const originalDoNotTrack = process.env.DO_NOT_TRACK;
  const originalLettaBaseUrl = process.env.LETTA_BASE_URL;
  const originalLettaDesktopDebugPanel = process.env.LETTA_DESKTOP_MODE;
  const originalLocalBackendExperimental =
    process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;

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
    telemetryState.surface = "letta_code_tui";
    telemetryState.sessionEndTracked = false;
    deleteEnvVarCaseInsensitive("LETTA_API_KEY");
    deleteEnvVarCaseInsensitive("LETTA_TELEMETRY_DISABLED");
    deleteEnvVarCaseInsensitive("DO_NOT_TRACK");
    deleteEnvVarCaseInsensitive("LETTA_BASE_URL");
    deleteEnvVarCaseInsensitive("LETTA_DESKTOP_MODE");
    deleteEnvVarCaseInsensitive("LETTA_LOCAL_BACKEND_EXPERIMENTAL");
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
    restoreEnvVar("DO_NOT_TRACK", originalDoNotTrack);
    restoreEnvVar("LETTA_BASE_URL", originalLettaBaseUrl);
    restoreEnvVar("LETTA_DESKTOP_MODE", originalLettaDesktopDebugPanel);
    restoreEnvVar(
      "LETTA_LOCAL_BACKEND_EXPERIMENTAL",
      originalLocalBackendExperimental,
    );
  });

  test("usage events include segmentation properties", () => {
    telemetry.trackUserInput("hello", "user", "model-1");

    expect(telemetryState.events).toHaveLength(1);
    const event = telemetryState.events[0] as {
      data?: {
        surface?: TelemetrySurface;
        backend?: TelemetryBackend;
      };
    };
    expect(event.data?.surface).toBeDefined();
    expect(event.data?.backend).toBeDefined();
    expect(telemetrySurfaces).toContain(
      event.data?.surface as TelemetrySurface,
    );
    expect(telemetryBackends).toContain(
      event.data?.backend as TelemetryBackend,
    );
  });

  test("DO_NOT_TRACK=1 disables runtime telemetry", () => {
    setEnvVar("DO_NOT_TRACK", "1");

    telemetry.trackUserInput("hello", "user", "model-1");

    expect(telemetryState.events).toHaveLength(0);
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

    const fetchMock = mock(async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://api.letta.com/v1/metadata/telemetry");
      return new Response(null, { status: 200 });
    });
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

  test("desktop listener telemetry routes through the local proxy", async () => {
    setEnvVar("LETTA_DESKTOP_MODE", "1");
    setEnvVar("LETTA_BASE_URL", "http://localhost:54321");
    setEnvVar("LETTA_API_KEY", "desktop-session-token");

    const fetchMock = mock(
      async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe(
          "http://localhost:54321/v1/metadata/telemetry",
        );
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer desktop-session-token",
        });
        return new Response(null, { status: 200 });
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    telemetry.trackReflectionStart("step-count", {
      conversationId: "conv-1",
    });
    await telemetry.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
