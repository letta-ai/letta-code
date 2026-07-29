import { describe, expect, test } from "bun:test";
import {
  getCloudCommandEligibilityError,
  parseCloudCommand,
} from "./cloud-command";

describe("parseCloudCommand", () => {
  test("enables Cloud mode without an instruction", () => {
    expect(parseCloudCommand("/cloud")).toEqual({ instruction: null });
    expect(parseCloudCommand("  /CLOUD  ")).toEqual({ instruction: null });
  });

  test("preserves the continuation instruction", () => {
    expect(parseCloudCommand("/cloud run the tests and fix failures")).toEqual({
      instruction: "run the tests and fix failures",
    });
  });

  test("does not match adjacent command names", () => {
    expect(parseCloudCommand("/cloudy")).toBeNull();
    expect(parseCloudCommand("hello /cloud")).toBeNull();
  });
});

describe("getCloudCommandEligibilityError", () => {
  test("accepts hosted agents on api.letta.com", () => {
    expect(
      getCloudCommandEligibilityError({
        agentId: "agent-123",
        serverUrl: "https://api.letta.com",
      }),
    ).toBeNull();
  });

  test("rejects local agents and non-Letta servers", () => {
    expect(
      getCloudCommandEligibilityError({
        agentId: "agent-local-123",
        serverUrl: "https://api.letta.com",
      }),
    ).toContain("agents hosted on Letta Cloud");
    expect(
      getCloudCommandEligibilityError({
        agentId: "agent-123",
        serverUrl: "http://localhost:8283",
      }),
    ).toContain("connected to Letta Cloud");
  });
});
