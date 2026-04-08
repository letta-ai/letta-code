import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { settingsManager } from "../../settings-manager";
import { telemetry } from "../../telemetry";

type TelemetryTestState = {
  events: unknown[];
  flushInFlight: Promise<void> | null;
  messageCount: number;
  currentAgentId: string | null;
  surface: "tui" | "headless" | "websocket";
  sessionEndTracked: boolean;
};

const telemetryState = telemetry as unknown as TelemetryTestState;

describe("telemetry flush auth", () => {
  const originalFetch = globalThis.fetch;
  const originalGetSettingsWithSecureTokens =
    settingsManager.getSettingsWithSecureTokens;

  beforeEach(() => {
    telemetry.cleanup();
    telemetryState.events = [];
    telemetryState.flushInFlight = null;
    telemetryState.messageCount = 0;
    telemetryState.currentAgentId = null;
    telemetryState.surface = "tui";
    telemetryState.sessionEndTracked = false;
    delete process.env.LETTA_API_KEY;
    delete process.env.LETTA_TELEMETRY_DISABLED;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    settingsManager.getSettingsWithSecureTokens =
      originalGetSettingsWithSecureTokens;
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

  test("flush prefers env token over secure settings token", async () => {
    process.env.LETTA_API_KEY = "env-key";

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

  test("concurrent flush calls share one in-flight request", async () => {
    let resolveFetch!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      resolveFetch = resolve;
    });

    const fetchMock = mock(async () => {
      await fetchStarted;
      return new Response(null, { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    settingsManager.getSettingsWithSecureTokens = mock(async () => ({
      env: {
        LETTA_API_KEY: "settings-key",
      },
    })) as unknown as typeof settingsManager.getSettingsWithSecureTokens;

    telemetry.trackUserInput("hello", "user", "model-1");

    const flushA = telemetry.flush();
    const flushB = telemetry.flush();

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch();
    await Promise.all([flushA, flushB]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
