import { describe, expect, mock, test } from "bun:test";
import { __headlessTestUtils } from "../../headless";
import { telemetry } from "../../telemetry";

describe("headless telemetry input tracking", () => {
  test("tracks text-bearing user content", () => {
    const originalTrackUserInput = telemetry.trackUserInput;
    const trackUserInputMock = mock(() => {});
    telemetry.trackUserInput =
      trackUserInputMock as typeof telemetry.trackUserInput;

    try {
      __headlessTestUtils.trackTelemetryUserInputFromContent(
        [{ type: "text", text: "hello from sdk" }],
        "model-1",
      );

      expect(trackUserInputMock).toHaveBeenCalledWith(
        "hello from sdk",
        "user",
        "model-1",
      );
    } finally {
      telemetry.trackUserInput = originalTrackUserInput;
    }
  });

  test("skips image-only user content", () => {
    const originalTrackUserInput = telemetry.trackUserInput;
    const trackUserInputMock = mock(() => {});
    telemetry.trackUserInput =
      trackUserInputMock as typeof telemetry.trackUserInput;

    try {
      __headlessTestUtils.trackTelemetryUserInputFromContent(
        [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "abc",
            },
          },
        ],
        "model-1",
      );

      expect(trackUserInputMock).not.toHaveBeenCalled();
    } finally {
      telemetry.trackUserInput = originalTrackUserInput;
    }
  });
});
