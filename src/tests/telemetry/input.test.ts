import { describe, expect, test } from "bun:test";
import { extractTelemetryInputText } from "../../telemetry/input";

describe("extractTelemetryInputText", () => {
  test("returns plain string input unchanged", () => {
    expect(extractTelemetryInputText("hello")).toBe("hello");
  });

  test("concatenates text parts and skips non-text parts", () => {
    expect(
      extractTelemetryInputText([
        { type: "text", text: "hello" },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "abc",
          },
        },
        { type: "text", text: "world" },
      ]),
    ).toBe("hello\nworld");
  });
});
