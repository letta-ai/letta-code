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
      },
      error_code: "authorization_failed",
    });
    expect(event.handoff_key).toBe("live-handoff");
  });

  test("never copies malformed raw payloads into debug collectors", () => {
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
      raw: '{"handoff_key":"live-handoff", "state":"oauth-state"',
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
