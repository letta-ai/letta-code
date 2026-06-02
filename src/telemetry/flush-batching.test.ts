import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { settingsManager } from "@/settings-manager";
import { type TelemetrySurface, telemetry } from "@/telemetry";

type TelemetryTestState = {
  events: unknown[];
  messageCount: number;
  currentAgentId: string | null;
  surface: TelemetrySurface;
  sessionEndTracked: boolean;
  inflightFlush: Promise<void> | null;
  isCloudUser: () => boolean;
};

const telemetryState = telemetry as unknown as TelemetryTestState;

function deleteEnvVarCaseInsensitive(name: string): void {
  const normalized = name.toLowerCase();
  for (const key of Object.keys(process.env)) {
    if (key.toLowerCase() === normalized) {
      delete process.env[key];
    }
  }
}

describe("telemetry flush batching", () => {
  const originalFetch = globalThis.fetch;
  const originalGetSettingsWithSecureTokens =
    settingsManager.getSettingsWithSecureTokens;
  const originalGetSettings = settingsManager.getSettings;

  beforeEach(() => {
    telemetry.cleanup();
    telemetryState.events = [];
    telemetryState.messageCount = 0;
    telemetryState.currentAgentId = null;
    telemetryState.surface = "letta_code_tui";
    telemetryState.sessionEndTracked = false;
    telemetryState.inflightFlush = null;
    deleteEnvVarCaseInsensitive("LETTA_API_KEY");
    deleteEnvVarCaseInsensitive("LETTA_TELEMETRY_DISABLED");
    deleteEnvVarCaseInsensitive("LETTA_BASE_URL");
    settingsManager.getSettings = mock(() => ({
      env: {},
    })) as unknown as typeof settingsManager.getSettings;
    settingsManager.getSettingsWithSecureTokens = mock(async () => ({
      env: { LETTA_API_KEY: "settings-key" },
    })) as unknown as typeof settingsManager.getSettingsWithSecureTokens;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    settingsManager.getSettingsWithSecureTokens =
      originalGetSettingsWithSecureTokens;
    settingsManager.getSettings = originalGetSettings;
  });

  test("concurrent flush() callers share one in-flight POST", async () => {
    const deferred: { resolve: (value: Response) => void } = {
      resolve: () => {},
    };
    const pending = new Promise<Response>((resolve) => {
      deferred.resolve = resolve;
    });
    const fetchMock = mock(() => pending);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    telemetry.trackUserInput("hello", "user", "model-1");

    // Fire three flushes back to back — they should all share the same POST,
    // which is the core defense against the 429 route_rps_rate_limit_exceeded
    // race we hit on shutdown when SIGINT + normal-exit handlers both flush.
    const a = telemetry.flush();
    const b = telemetry.flush();
    const c = telemetry.flush();

    // Yield long enough for performFlush's `await resolveTelemetryApiKey()`
    // microtask to complete and the underlying fetch to be issued — but the
    // fetch itself is hung on `pending`, so the in-flight guard still
    // applies to b and c.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Resolve the single in-flight request and let all three callers settle.
    deferred.resolve(new Response(null, { status: 200 }));
    await Promise.all([a, b, c]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(telemetryState.events).toHaveLength(0);
  });

  test("drain awaits the in-flight flush and exits when queue is empty", async () => {
    const fetchMock = mock(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    telemetry.trackUserInput("hello", "user", "model-1");
    telemetry.trackUserInput("world", "user", "model-1");

    const drainable = telemetry as unknown as { drain: () => Promise<void> };
    await drainable.drain();

    expect(telemetryState.events).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalled();
  });

  test("drain re-runs flush when new events arrive mid-drain", async () => {
    let firstCall = true;
    const fetchMock = mock(async () => {
      if (firstCall) {
        firstCall = false;
        // Simulate a trackError happening (e.g. uncaughtException handler)
        // while the first POST is in flight.
        telemetry.trackUserInput("late", "user", "model-1");
      }
      return new Response(null, { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    telemetry.trackUserInput("first", "user", "model-1");

    const drainable = telemetry as unknown as { drain: () => Promise<void> };
    await drainable.drain();

    // First flush sent 1 event, then drain noticed the late event and flushed
    // again. Queue should be empty after drain returns.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(telemetryState.events).toHaveLength(0);
  });

  test("flush failure re-queues events without throwing", async () => {
    const fetchMock = mock(async () => new Response(null, { status: 500 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    telemetry.trackUserInput("hello", "user", "model-1");
    expect(telemetryState.events).toHaveLength(1);

    await telemetry.flush();

    // 500 → submitTelemetryMetadata throws → performFlush re-queues.
    expect(telemetryState.events).toHaveLength(1);
  });
});

describe("reflection telemetry correlation", () => {
  const originalFetch = globalThis.fetch;
  const originalGetSettingsWithSecureTokens =
    settingsManager.getSettingsWithSecureTokens;
  const originalGetSettings = settingsManager.getSettings;

  beforeEach(() => {
    telemetry.cleanup();
    telemetryState.events = [];
    telemetryState.messageCount = 0;
    telemetryState.currentAgentId = null;
    telemetryState.surface = "letta_code_tui";
    telemetryState.sessionEndTracked = false;
    telemetryState.inflightFlush = null;
    deleteEnvVarCaseInsensitive("LETTA_API_KEY");
    settingsManager.getSettings = mock(() => ({
      env: {},
    })) as unknown as typeof settingsManager.getSettings;
    settingsManager.getSettingsWithSecureTokens = mock(async () => ({
      env: { LETTA_API_KEY: "settings-key" },
    })) as unknown as typeof settingsManager.getSettingsWithSecureTokens;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    settingsManager.getSettingsWithSecureTokens =
      originalGetSettingsWithSecureTokens;
    settingsManager.getSettings = originalGetSettings;
  });

  test("reflection_end carries start_message_id and end_message_id", () => {
    telemetry.trackReflectionEnd("step-count", true, {
      subagentId: "agent-deadbeef",
      conversationId: "conv-1",
      startMessageId: "message-start",
      endMessageId: "message-end",
    });

    const event = telemetryState.events[0] as {
      type: string;
      data: {
        subagent_id?: string;
        start_message_id?: string;
        end_message_id?: string;
      };
    };
    expect(event.type).toBe("reflection_end");
    expect(event.data.subagent_id).toBe("agent-deadbeef");
    expect(event.data.start_message_id).toBe("message-start");
    expect(event.data.end_message_id).toBe("message-end");
  });

  test("both reflection_start and reflection_end carry subagent_id for in-flight tracking", () => {
    // Mirrors the post-deferred-emit launcher: by the time
    // trackReflectionStart fires (after the background agent-id wait), we
    // have a real subagent_id, so in-flight reflections are identifiable
    // even if reflection_end never lands (crash / early exit / long-running).
    telemetry.trackReflectionStart("step-count", {
      subagentId: "agent-resolved-in-background",
      conversationId: "conv-1",
      startMessageId: "message-start-1",
      endMessageId: "message-end-1",
    });

    telemetry.trackReflectionEnd("step-count", true, {
      subagentId: "agent-resolved-in-background",
      conversationId: "conv-1",
      startMessageId: "message-start-1",
      endMessageId: "message-end-1",
    });

    expect(telemetryState.events).toHaveLength(2);
    type ReflectionEvent = {
      type: string;
      data: { start_message_id?: string; subagent_id?: string };
    };
    const events = telemetryState.events as ReflectionEvent[];
    const startEvent = events[0];
    const endEvent = events[1];
    if (!startEvent || !endEvent) {
      throw new Error("Expected start + end reflection events");
    }

    expect(startEvent.type).toBe("reflection_start");
    expect(endEvent.type).toBe("reflection_end");

    // The key invariant: subagent_id is populated on both, so dashboards can
    // identify the subagent from reflection_start alone (no JOIN needed).
    expect(startEvent.data.subagent_id).toBe("agent-resolved-in-background");
    expect(endEvent.data.subagent_id).toBe("agent-resolved-in-background");

    // start_message_id is still the stable correlation key for pairing.
    expect(startEvent.data.start_message_id).toBe(
      endEvent.data.start_message_id,
    );
  });

  test("reflection_start falls back to undefined subagent_id if wait times out", () => {
    // Worst case: background wait times out before agent ID is assigned. We
    // still emit the event (with undefined subagent_id) rather than dropping
    // it, so we have at least a launch record.
    telemetry.trackReflectionStart("step-count", {
      subagentId: undefined,
      conversationId: "conv-1",
      startMessageId: "message-start-2",
      endMessageId: "message-end-2",
    });

    const event = telemetryState.events[0] as {
      type: string;
      data: { subagent_id?: string; start_message_id?: string };
    };
    expect(event.type).toBe("reflection_start");
    expect(event.data.subagent_id).toBeUndefined();
    expect(event.data.start_message_id).toBe("message-start-2");
  });
});
