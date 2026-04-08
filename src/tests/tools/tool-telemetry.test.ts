import { describe, expect, test } from "bun:test";
import { __toolTelemetryTestUtils } from "../../tools/manager";

describe("tool telemetry size estimation", () => {
  test("uses string length for text responses", () => {
    expect(__toolTelemetryTestUtils.estimateToolResponseSize("hello")).toBe(5);
  });

  test("sums multimodal block sizes without JSON serialization", () => {
    expect(
      __toolTelemetryTestUtils.estimateToolResponseSize([
        { type: "text", text: "hello" },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "abcd",
            detail: "high",
          },
        },
      ]),
    ).toBe(5 + 4 + "image/png".length + "high".length);
  });
});
