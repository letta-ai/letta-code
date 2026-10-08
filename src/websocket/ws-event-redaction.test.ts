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
        error: "runtime unavailable",
        state: "retrying",
        code: "E_RETRY",
        access_token: "secret-token",
      }),
    ).toEqual({
      type: "sync_response",
      error: "runtime unavailable",
      state: "retrying",
      code: "E_RETRY",
      access_token: "[REDACTED]",
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
