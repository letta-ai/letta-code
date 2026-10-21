import { describe, expect, test } from "bun:test";
import { getFeedbackClientType } from "@/backend/api/metadata";

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
