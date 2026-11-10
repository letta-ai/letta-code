import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { reportBusyRecovery } from "@/telemetry/busy-recovery";
import { type TelemetryEvent, telemetry } from "@/telemetry/index";

const state = telemetry as unknown as { events: TelemetryEvent[] };
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
let originalEvents: TelemetryEvent[];

describe("busy recovery telemetry", () => {
  test("flush serializes the diagnostic to the existing metadata HTTP route", async () => {
    process.env.LETTA_API_KEY = "synthetic-test-key";
    delete process.env.LETTA_DESKTOP_MODE;
    const receipts: Array<{ url: string; method?: string; body: string }> = [];
    globalThis.fetch = (async (...[url, options]: Parameters<typeof fetch>) => {
      receipts.push({
        url: String(url),
        method: options?.method,
        body: String(options?.body),
      });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;
    reportBusyRecovery("poll_timed_out", {
      blockerRunId: "run-example",
      pollCount: 60,
      elapsedMs: 300000,
    });
    await telemetry.flush();
    expect(receipts).toHaveLength(1);
    expect(new URL(receipts[0]?.url ?? "").pathname).toBe(
      "/v1/metadata/telemetry",
    );
    expect(receipts[0]?.method).toBe("POST");
    const payload = JSON.parse(receipts[0]?.body ?? "");
    expect(payload.service).toBe("letta-code");
    expect(payload.events[0].type).toBe("error");
    expect(JSON.parse(payload.events[0].data.context)).toMatchObject({
      phase: "poll_timed_out",
      blocker_run_id: "run-example",
    });
    expect(payload.events[0].data).not.toHaveProperty("debug_log_tail");
    expect(receipts[0]?.body).not.toContain("synthetic-test-key");
    expect(state.events).toHaveLength(0);
  });

  beforeEach(() => {
    originalEvents = state.events;
    state.events = [];
    process.env.LETTA_BASE_URL = "https://api.letta.com";
    process.env.LETTA_CODE_TELEM = "1";
    delete process.env.DO_NOT_TRACK;
  });
  afterEach(() => {
    state.events = originalEvents;
    globalThis.fetch = originalFetch;
    for (const key of [
      "LETTA_BASE_URL",
      "LETTA_CODE_TELEM",
      "DO_NOT_TRACK",
      "LETTA_API_KEY",
      "LETTA_DESKTOP_MODE",
    ]) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  test("queues opaque request and blocker identities separately without content", () => {
    reportBusyRecovery("send_rejected", {
      conversationId: "conv-example",
      otid: "request-example",
      blockerRunId: "run-blocker",
      httpStatus: 409,
    });
    const event = state.events[0];
    expect(event?.data.error_type).toBe("conversation_busy_recovery");
    expect(event?.data.http_status).toBe(409);
    expect(event?.data.version).toBeString();
    expect(event?.data.surface).toBeString();
    expect(event?.data.session_id).toBeString();
    expect(JSON.parse(event?.data.context as string)).toMatchObject({
      phase: "send_rejected",
      conversation_id: "conv-example",
      request_otid: "request-example",
      blocker_run_id: "run-blocker",
    });
    expect(event?.data.debug_log_tail).toBeUndefined();
    expect(event?.data.recent_chunks).toBeUndefined();
    expect(event?.data.model_id).toBeUndefined();
  });

  test("drops invalid identifiers and numeric fields rather than serializing them", () => {
    reportBusyRecovery("poll_failed", {
      conversationId: "prompt with secret",
      otid: "x".repeat(129),
      blockerRunId: "https://example.com?token=secret",
      httpStatus: 999,
      runStatus: { toString: () => "running", secret: "hidden" },
      pollCount: Number.NaN,
      elapsedMs: -1,
    });
    const event = state.events[0];
    const context = JSON.parse(event?.data.context as string);
    expect(Object.keys(context).sort()).toEqual(["client_timestamp", "phase"]);
    expect(event?.data.http_status).toBeUndefined();
  });

  test("delivery requeues transient failures, drops schema rejection, and stops on opt-out", async () => {
    process.env.LETTA_API_KEY = "synthetic-test-key";
    delete process.env.LETTA_DESKTOP_MODE;
    let requests = 0;
    let responseStatus = 503;
    globalThis.fetch = (async () => {
      requests += 1;
      return new Response("{}", { status: responseStatus });
    }) as unknown as typeof fetch;
    reportBusyRecovery("poll_failed", { httpStatus: 503 });
    process.env.DO_NOT_TRACK = "1";
    await telemetry.flush();
    expect(requests).toBe(0);
    delete process.env.DO_NOT_TRACK;
    await telemetry.flush();
    expect(requests).toBe(1);
    expect(state.events).toHaveLength(1);
    responseStatus = 400;
    await telemetry.flush();
    expect(requests).toBe(2);
    expect(state.events).toHaveLength(0);
  });

  test("honors both opt-out settings", () => {
    process.env.DO_NOT_TRACK = "1";
    reportBusyRecovery("poll_started");
    delete process.env.DO_NOT_TRACK;
    process.env.LETTA_CODE_TELEM = "0";
    reportBusyRecovery("poll_started");
    expect(state.events).toHaveLength(0);
  });

  test("does not send diagnostics for self-hosted backends", () => {
    process.env.LETTA_BASE_URL = "https://example.com";
    reportBusyRecovery("poll_started");
    expect(state.events).toHaveLength(0);
  });
});
