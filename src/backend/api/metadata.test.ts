import { describe, expect, test } from "bun:test";
import {
  feedbackResultMessage,
  getFeedbackClientType,
  parseFeedbackResult,
} from "@/backend/api/metadata";

test("preserves decisions and supports legacy success-only responses", () => {
  expect(
    feedbackResultMessage(parseFeedbackResult({ success: true })),
  ).toContain("Feedback submitted");
  expect(
    feedbackResultMessage(
      parseFeedbackResult({
        success: false,
        status: "rejected",
        message: "Do not retry.",
      }),
    ),
  ).toBe("Do not retry.");
  expect(
    feedbackResultMessage(parseFeedbackResult({ success: false })),
  ).not.toContain("submitted");
  for (const invalid of [
    undefined,
    {},
    { success: true, status: "rejected" },
    { success: false, status: "accepted" },
    { success: true, message: 7 },
  ]) {
    expect(() => parseFeedbackResult(invalid)).toThrow();
  }
});

describe("feedback client attribution", () => {
  test("identifies Desktop before other runtime markers", () => {
    expect(
      getFeedbackClientType({
        LETTA_DESKTOP_MODE: "1",
        LETTA_RUNTIME_ENVIRONMENT_DEVICE_ID: "sandbox-1",
      }),
    ).toBe("desktop");
  });

  test("identifies chat.letta.com cloud runtimes", () => {
    expect(
      getFeedbackClientType({
        LETTA_RUNTIME_ENVIRONMENT_DEVICE_ID: "sandbox-1",
      }),
    ).toBe("chat.letta.com");
  });

  test("uses CLI for local non-Desktop runtimes", () => {
    expect(getFeedbackClientType({})).toBe("cli");
  });
});
