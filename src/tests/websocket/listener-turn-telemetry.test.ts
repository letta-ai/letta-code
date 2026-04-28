import { describe, expect, mock, test } from "bun:test";
import { telemetry } from "../../telemetry";
import { __listenerTurnTestUtils } from "../../websocket/listener/turn";

describe("listener turn telemetry", () => {
  test("tracks only user messages with text content", () => {
    const originalTrackUserInput = telemetry.trackUserInput;
    const trackUserInputMock = mock(() => {});
    telemetry.trackUserInput =
      trackUserInputMock as typeof telemetry.trackUserInput;

    try {
      __listenerTurnTestUtils.trackListenerUserInput(
        [
          { role: "user", content: [{ type: "text", text: "hello" }] },
          {
            type: "approval",
            approvals: [],
            otid: "approval-1",
          },
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "abc",
                },
              },
            ],
          },
        ],
        "unknown",
      );

      expect(trackUserInputMock).toHaveBeenCalledTimes(1);
      expect(trackUserInputMock).toHaveBeenCalledWith(
        "hello",
        "user",
        "unknown",
      );
    } finally {
      telemetry.trackUserInput = originalTrackUserInput;
    }
  });
});
