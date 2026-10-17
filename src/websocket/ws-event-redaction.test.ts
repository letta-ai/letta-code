import { afterEach, describe, expect, test } from "bun:test";
import { safeEmitWsEvent, setActiveRuntime } from "./listener/runtime";
import type { ListenerRuntime } from "./listener/types";
import { redactWsEventForLogging } from "./ws-event-redaction";

afterEach(() => setActiveRuntime(null));

describe("WS event redaction", () => {
  test("redacts parsed OAuth secrets without mutating the event", () => {
    const event = {
      type: "browser_device_mcp_oauth",
      handoff_key: "live-handoff",
      provider: {
        code: "oauth-code",
        state: "oauth-state",
        refresh_token: "refresh-token",
        error: "provider-body",
        provider_response: "raw-provider-response",
      },
      error_code: "authorization_failed",
    };

    expect(redactWsEventForLogging(event)).toEqual({
      type: "browser_device_mcp_oauth",
      handoff_key: "[REDACTED]",
      provider: {
        code: "[REDACTED]",
        state: "[REDACTED]",
        refresh_token: "[REDACTED]",
        error: "[REDACTED]",
        provider_response: "[REDACTED]",
      },
      error_code: "authorization_failed",
    });
    expect(event.handoff_key).toBe("live-handoff");
  });

  test("preserves unrelated protocol diagnostics while redacting clear secrets", () => {
    expect(
      redactWsEventForLogging({
        type: "sync_response",
        error: '{"upstream":"truncated"',
        state: '{"phase":"retrying"}',
        code: "E_RETRY",
        access_token: "secret-token",
      }),
    ).toEqual({
      type: "sync_response",
      error: '{"upstream":"truncated"',
      state: '{"phase":"retrying"}',
      code: "E_RETRY",
      access_token: "[REDACTED]",
    });
  });

  test("redacts MCP originator token material while keeping its run id", () => {
    // USER_SCOPED_MCP_CONNECTIONS: the relay delivers bearer originator
    // tokens on top-level input frames. They must never reach debug logs or
    // serialized event dumps; the super run id is not secret and stays.
    expect(
      redactWsEventForLogging({
        type: "input",
        super_run_id: "sr-1",
        mcp_originator_token: "mst_one.secret-a",
        payload: {
          kind: "create_message",
          messages: [{ role: "user", content: "hello" }],
        },
      }),
    ).toEqual({
      type: "input",
      super_run_id: "sr-1",
      mcp_originator_token: "[REDACTED]",
      payload: {
        kind: "create_message",
        messages: [{ role: "user", content: "hello" }],
      },
    });
  });

  test("never copies identifiable malformed OAuth payloads into debug collectors", () => {
    const collected: unknown[] = [];
    setActiveRuntime({
      onWsEvent: (
        _direction: "send" | "recv",
        _label: "client" | "protocol" | "control" | "lifecycle",
        event: unknown,
      ) => {
        collected.push(event);
      },
    } as unknown as ListenerRuntime);

    safeEmitWsEvent("recv", "lifecycle", {
      type: "_ws_unparseable",
      raw: '{"type":"browser_device_mcp_oauth","handoff_key":"live-handoff","state":"oauth-state"',
    });

    expect(collected).toEqual([
      {
        type: "_ws_unparseable",
        raw: "[REDACTED_UNPARSEABLE_WS_PAYLOAD]",
      },
    ]);
    expect(JSON.stringify(collected)).not.toContain("live-handoff");
    expect(JSON.stringify(collected)).not.toContain("oauth-state");
  });
});
