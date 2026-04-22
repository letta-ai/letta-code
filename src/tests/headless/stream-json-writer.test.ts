import { afterEach, describe, expect, mock, test } from "bun:test";
import { writeWireMessage } from "../../streamJsonWriter";
import type { ControlRequest, MessageWire } from "../../types/protocol";

const originalConsoleLog = console.log;

afterEach(() => {
  console.log = originalConsoleLog;
});

describe("writeWireMessage", () => {
  test("stamps control_request lines with an ISO timestamp", () => {
    const consoleLog = mock((..._args: unknown[]) => {});
    console.log = consoleLog as typeof console.log;

    const msg: ControlRequest = {
      type: "control_request",
      request_id: "req-1",
      request: { subtype: "interrupt" },
    };

    writeWireMessage(msg);

    expect(consoleLog).toHaveBeenCalledTimes(1);
    const firstCall = consoleLog.mock.calls[0];
    const payload = JSON.parse(String(firstCall?.[0])) as {
      type: string;
      timestamp?: string;
      request_id: string;
    };

    expect(payload.type).toBe("control_request");
    expect(payload.request_id).toBe("req-1");
    expect(payload.timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  test("preserves caller-provided timestamps", () => {
    const consoleLog = mock((..._args: unknown[]) => {});
    console.log = consoleLog as typeof console.log;

    const msg: MessageWire = {
      type: "message",
      session_id: "session-1",
      uuid: "uuid-1",
      message_type: "assistant_message",
      id: "msg-1",
      date: "2026-04-22T00:00:00.000Z",
      content: [{ type: "text", text: "hi" }],
      timestamp: "2026-04-21T23:59:59.000Z",
    };

    writeWireMessage(msg);

    const firstCall = consoleLog.mock.calls[0];
    const payload = JSON.parse(String(firstCall?.[0])) as {
      timestamp?: string;
    };
    expect(payload.timestamp).toBe("2026-04-21T23:59:59.000Z");
  });
});
