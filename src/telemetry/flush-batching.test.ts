import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { settingsManager } from "@/settings-manager";
import { type TelemetrySurface, telemetry } from "@/telemetry";

type TelemetryTestState = {
  events: unknown[];
  messageCount: number;
  toolCallCount: number;
  currentAgentId: string | null;
  surface: TelemetrySurface;
  sessionEndTracked: boolean;
  inflightFlush: Promise<void> | null;
  MAX_BATCH_SIZE: number;
  toolUsageAggregate: unknown | null;
  errorSuppressionStates: Map<string, unknown>;
  nextErrorSuppressionSummaryMs: number | null;
  isCloudUser: () => boolean;
};

type CapturedTelemetryEvent = {
  type: string;
  data: Record<string, unknown>;
};

type CapturedTelemetryPayload = {
  events?: CapturedTelemetryEvent[];
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
    telemetryState.toolCallCount = 0;
    telemetryState.currentAgentId = null;
    telemetryState.surface = "letta_code_tui";
    telemetryState.sessionEndTracked = false;
    telemetryState.inflightFlush = null;
    telemetryState.MAX_BATCH_SIZE = 50;
    telemetryState.toolUsageAggregate = null;
    telemetryState.errorSuppressionStates = new Map();
    telemetryState.nextErrorSuppressionSummaryMs = null;
    deleteEnvVarCaseInsensitive("LETTA_API_KEY");
    deleteEnvVarCaseInsensitive("LETTA_TELEMETRY_DISABLED");
    deleteEnvVarCaseInsensitive("LETTA_CODE_TELEM");
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
    telemetryState.toolCallCount = 0;
    telemetryState.currentAgentId = null;
    telemetryState.surface = "letta_code_tui";
    telemetryState.sessionEndTracked = false;
    telemetryState.inflightFlush = null;
    telemetryState.MAX_BATCH_SIZE = 50;
    telemetryState.toolUsageAggregate = null;
    telemetryState.errorSuppressionStates = new Map();
    telemetryState.nextErrorSuppressionSummaryMs = null;
    deleteEnvVarCaseInsensitive("LETTA_API_KEY");
    deleteEnvVarCaseInsensitive("LETTA_CODE_TELEM");
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
    });

    expect(telemetryState.events).toHaveLength(2);
    type ReflectionEvent = {
      type: string;
      data: { subagent_id?: string };
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

describe("telemetry aggregation controls", () => {
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  const originalGetSettingsWithSecureTokens =
    settingsManager.getSettingsWithSecureTokens;
  const originalGetSettings = settingsManager.getSettings;
  const originalIsCloudUser = telemetryState.isCloudUser;

  function resetTelemetryTestState(): void {
    telemetry.cleanup();
    telemetryState.events = [];
    telemetryState.messageCount = 0;
    telemetryState.toolCallCount = 0;
    telemetryState.currentAgentId = null;
    telemetryState.surface = "letta_code_tui";
    telemetryState.sessionEndTracked = false;
    telemetryState.inflightFlush = null;
    telemetryState.MAX_BATCH_SIZE = 50;
    telemetryState.toolUsageAggregate = null;
    telemetryState.errorSuppressionStates = new Map();
    telemetryState.nextErrorSuppressionSummaryMs = null;
  }

  function installTelemetryCapture(status = 200): {
    payloads: CapturedTelemetryPayload[];
    fetchMock: ReturnType<typeof mock>;
    setStatus: (nextStatus: number) => void;
  } {
    const payloads: CapturedTelemetryPayload[] = [];
    let responseStatus = status;
    const fetchMock = mock(
      async (_url: string | URL | Request, init?: RequestInit) => {
        payloads.push(
          JSON.parse(String(init?.body ?? "{}")) as CapturedTelemetryPayload,
        );
        return new Response(null, { status: responseStatus });
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return {
      payloads,
      fetchMock,
      setStatus: (nextStatus: number) => {
        responseStatus = nextStatus;
      },
    };
  }

  function setNow(now: number): void {
    Date.now = mock(() => now) as unknown as typeof Date.now;
  }

  beforeEach(() => {
    resetTelemetryTestState();
    Date.now = originalDateNow;
    deleteEnvVarCaseInsensitive("LETTA_API_KEY");
    deleteEnvVarCaseInsensitive("LETTA_TELEMETRY_DISABLED");
    deleteEnvVarCaseInsensitive("LETTA_CODE_TELEM");
    deleteEnvVarCaseInsensitive("DO_NOT_TRACK");
    deleteEnvVarCaseInsensitive("LETTA_BASE_URL");
    telemetryState.isCloudUser = () => true;
    settingsManager.getSettings = mock(() => ({
      env: {},
    })) as unknown as typeof settingsManager.getSettings;
    settingsManager.getSettingsWithSecureTokens = mock(async () => ({
      env: { LETTA_API_KEY: "settings-key" },
    })) as unknown as typeof settingsManager.getSettingsWithSecureTokens;
  });

  afterEach(() => {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
    settingsManager.getSettingsWithSecureTokens =
      originalGetSettingsWithSecureTokens;
    settingsManager.getSettings = originalGetSettings;
    telemetryState.isCloudUser = originalIsCloudUser;
  });

  test("flush collapses named tool calls into one backward-compatible aggregate event", async () => {
    const { payloads, fetchMock } = installTelemetryCapture();
    const longToolName = `Long ${"x".repeat(200)}`;
    const truncatedLongToolName = longToolName.slice(0, 120);
    telemetry.setCurrentAgentId("agent-1");

    telemetry.trackToolUsage("Bash", true, 10, 100);
    telemetry.trackToolUsage("Bash", false, 20, 50);
    telemetry.trackToolUsage("Read", true, 5, 25);
    telemetry.trackToolUsage("  Tool\tWith\nSpaces  ", true, 7, 0);
    telemetry.trackToolUsage(longToolName, true, 3, 2);

    expect(telemetryState.events).toHaveLength(0);
    expect(telemetry.getToolCallCount()).toBe(5);

    await telemetry.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const events = payloads[0]?.events ?? [];
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.type).toBe("tool_usage");
    expect(event?.data.tool_name).toBe("aggregate");
    expect(event?.data.success).toBe(false);
    expect(event?.data.duration).toBe(45);
    expect(event?.data.response_length).toBe(177);
    expect(event?.data.call_count).toBe(5);
    expect(event?.data.success_count).toBe(4);
    expect(event?.data.error_count).toBe(1);
    expect(event?.data.agent_id).toBe("agent-1");
    expect(event?.data.tools).toEqual([
      {
        tool_name: "Bash",
        call_count: 2,
        success_count: 1,
        error_count: 1,
      },
      {
        tool_name: truncatedLongToolName,
        call_count: 1,
        success_count: 1,
        error_count: 0,
      },
      {
        tool_name: "Read",
        call_count: 1,
        success_count: 1,
        error_count: 0,
      },
      {
        tool_name: "Tool With Spaces",
        call_count: 1,
        success_count: 1,
        error_count: 0,
      },
    ]);
    for (const tool of event?.data.tools as Record<string, unknown>[]) {
      expect(Object.hasOwn(tool, "duration")).toBe(false);
      expect(Object.hasOwn(tool, "response_length")).toBe(false);
      expect(Object.hasOwn(tool, "stderr")).toBe(false);
      expect(Object.hasOwn(tool, "error_type")).toBe(false);
    }
    expect(Object.hasOwn(event?.data ?? {}, "stderr")).toBe(false);
    expect(Object.hasOwn(event?.data ?? {}, "error_type")).toBe(false);
    expect(Object.hasOwn(event?.data ?? {}, "tool_call_count")).toBe(false);
    expect(Object.hasOwn(event?.data ?? {}, "total_duration_ms")).toBe(false);
    expect(telemetryState.events).toHaveLength(0);
  });

  test("tool aggregate clamps invalid numeric inputs", async () => {
    const { payloads } = installTelemetryCapture();

    telemetry.trackToolUsage("Bash", true, Number.NaN, -5);
    telemetry.trackToolUsage(
      "Bash",
      true,
      Number.POSITIVE_INFINITY,
      Number.NaN,
    );

    await telemetry.flush();

    const event = payloads[0]?.events?.[0];
    expect(event?.type).toBe("tool_usage");
    expect(event?.data.duration).toBe(0);
    expect(Object.hasOwn(event?.data ?? {}, "response_length")).toBe(false);
    expect(event?.data.call_count).toBe(2);
    expect(event?.data.success_count).toBe(2);
    expect(event?.data.error_count).toBe(0);
    expect(event?.data.tools).toEqual([
      {
        tool_name: "Bash",
        call_count: 2,
        success_count: 2,
        error_count: 0,
      },
    ]);
  });

  test("tool aggregate caps retained tool names while preserving global totals", async () => {
    const { payloads } = installTelemetryCapture();

    for (let i = 0; i < 70; i += 1) {
      telemetry.trackToolUsage(`tool_${i}`, i % 2 === 0, 1, 1);
    }

    await telemetry.flush();

    const events = payloads[0]?.events ?? [];
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.type).toBe("tool_usage");
    expect(event?.data.call_count).toBe(70);
    expect(event?.data.success_count).toBe(35);
    expect(event?.data.error_count).toBe(35);
    expect(event?.data.duration).toBe(70);
    expect(event?.data.response_length).toBe(70);
    expect(event?.data.overflow_tool_call_count).toBe(6);
    expect(event?.data.tool_name_limit).toBe(64);
    const tools = event?.data.tools as Record<string, unknown>[];
    expect(tools).toHaveLength(64);
    for (const tool of tools) {
      expect(tool.tool_name).toStartWith("tool_");
      expect(tool.call_count).toBe(1);
      expect(Object.hasOwn(tool, "duration")).toBe(false);
      expect(Object.hasOwn(tool, "response_length")).toBe(false);
      expect(Object.hasOwn(tool, "stderr")).toBe(false);
      expect(Object.hasOwn(tool, "error_type")).toBe(false);
    }
  });

  test("session end emits pending aggregates before session_end", () => {
    telemetry.trackToolUsage("Bash", true, 12, 34);
    telemetry.trackError("stream_error", "same failure", "stream");
    telemetry.trackError("stream_error", "same failure", "stream");

    telemetry.trackSessionEnd(undefined, "exit_command");

    expect(telemetryState.events).toHaveLength(4);
    const events = telemetryState.events as CapturedTelemetryEvent[];
    expect(events[0]?.type).toBe("error");
    expect(events[1]?.type).toBe("tool_usage");
    expect(events[1]?.data.call_count).toBe(1);
    expect(events[2]?.type).toBe("error");
    expect(events[2]?.data.suppressed_count).toBe(1);
    expect(events[3]?.type).toBe("session_end");
    expect(events[3]?.data.tool_call_count).toBe(1);
  });

  test("mixed-agent tool aggregates omit agent attribution", async () => {
    const { payloads } = installTelemetryCapture();

    telemetry.setCurrentAgentId("agent-a");
    telemetry.trackToolUsage("Bash", true, 10, 10);
    telemetry.setCurrentAgentId("agent-b");
    telemetry.trackToolUsage("Read", true, 20, 20);

    await telemetry.flush();

    const event = payloads[0]?.events?.[0];
    expect(event?.type).toBe("tool_usage");
    expect(event?.data.call_count).toBe(2);
    expect(event?.data.agent_id).toBeUndefined();
  });

  test("duplicate process-boundary errors plus repeated drain send only the first event before cadence", async () => {
    const { payloads, fetchMock } = installTelemetryCapture();

    telemetry.trackError(
      "uncaught_exception",
      "same process failure",
      "process_uncaught_exception",
    );
    await telemetry.drain();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(payloads[0]?.events).toHaveLength(1);
    expect(payloads[0]?.events?.[0]?.type).toBe("error");

    for (let i = 0; i < 5; i += 1) {
      telemetry.trackError(
        "uncaught_exception",
        "same process failure",
        "process_uncaught_exception",
      );
      await telemetry.drain();
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(payloads).toHaveLength(1);
    expect(telemetryState.events).toHaveLength(0);
  });

  test("suppressed error summaries wait for the 30 minute cadence", async () => {
    const { payloads, fetchMock } = installTelemetryCapture();
    const start = 1_700_000_000_000;
    setNow(start);

    telemetry.trackError("stream_error", "same failure", "stream", {
      modelId: "model-1",
      runId: "run-1",
    });
    await telemetry.flush();

    telemetry.trackError("stream_error", "same failure", "stream", {
      modelId: "model-1",
      runId: "run-2",
    });
    await telemetry.flush();

    setNow(start + 30 * 60 * 1000 - 1);
    await telemetry.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    setNow(start + 30 * 60 * 1000);
    await telemetry.flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const summary = payloads[1]?.events?.[0];
    expect(summary?.type).toBe("error");
    expect(summary?.data.error_type).toBe("stream_error");
    expect(summary?.data.error_message).toBe("same failure");
    expect(summary?.data.context).toBe("stream");
    expect(summary?.data.model_id).toBe("model-1");
    expect(summary?.data.suppressed_count).toBe(1);
    expect(summary?.data.run_id).toBeUndefined();
    expect(summary?.data.recent_chunks).toBeUndefined();
    expect(summary?.data.debug_log_tail).toBeUndefined();
    expect(Object.hasOwn(summary?.data ?? {}, "error_fingerprint")).toBe(false);
  });

  test("session end emits suppressed error summaries immediately", async () => {
    const { payloads } = installTelemetryCapture();

    telemetry.trackError("stream_error", "same failure", "stream", {
      modelId: "model-1",
      runId: "run-1",
    });
    await telemetry.flush();

    telemetry.trackError("stream_error", "same failure", "stream", {
      modelId: "model-1",
      runId: "run-2",
    });
    telemetry.trackError("stream_error", "same failure", "stream", {
      modelId: "model-1",
      runId: "run-3",
    });
    telemetry.trackSessionEnd(undefined, "exit_command");
    await telemetry.flush();

    const events = payloads[1]?.events ?? [];
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("error");
    expect(events[0]?.data.suppressed_count).toBe(2);
    expect(events[1]?.type).toBe("session_end");
  });

  test("distinct error fingerprints are not suppressed", () => {
    const longPrefix = "x".repeat(600);

    telemetry.trackError("stream_error", "first failure", "stream", {
      modelId: "model-1",
    });
    telemetry.trackError("stream_error", "second failure", "stream", {
      modelId: "model-1",
    });
    telemetry.trackError("stream_error", "first failure", "other_context", {
      modelId: "model-1",
    });
    telemetry.trackError("stream_error", `${longPrefix}a`, "stream", {
      modelId: "model-1",
    });
    telemetry.trackError("stream_error", `${longPrefix}b`, "stream", {
      modelId: "model-1",
    });

    expect(telemetryState.events).toHaveLength(5);
    const events = telemetryState.events as CapturedTelemetryEvent[];
    expect(events.map((event) => event.data.error_message)).toEqual([
      "first failure",
      "second failure",
      "first failure",
      `${longPrefix}a`,
      `${longPrefix}b`,
    ]);
  });

  test("flush failure re-queues aggregate events for retry", async () => {
    const { payloads, fetchMock, setStatus } = installTelemetryCapture(500);

    telemetry.trackToolUsage("Bash", true, 7, 8);
    await telemetry.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(telemetryState.events).toHaveLength(1);

    setStatus(200);
    await telemetry.flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(payloads[1]?.events?.[0]?.data.call_count).toBe(1);
    expect(telemetryState.events).toHaveLength(0);
  });

  test("error fingerprint state stays bounded without eviction summary events", () => {
    telemetryState.MAX_BATCH_SIZE = 1_000;

    telemetry.trackError("bounded_error", "repeat", "state_bound", {
      modelId: "model-1",
    });
    telemetry.trackError("bounded_error", "repeat", "state_bound", {
      modelId: "model-1",
    });

    for (let i = 0; i < 128; i += 1) {
      telemetry.trackError("bounded_error", `failure ${i}`, "state_bound", {
        modelId: "model-1",
      });
    }

    expect(telemetryState.events).toHaveLength(129);
    expect(telemetryState.errorSuppressionStates.size).toBeLessThanOrEqual(128);
  });
});
