import { describe, expect, test } from "bun:test";
import { shouldIncludeCloudRecentAgents } from "@/cli/helpers/recent-agent-options";

describe("shouldIncludeCloudRecentAgents", () => {
  test("returns false when cloud fetch is disabled", () => {
    expect(
      shouldIncludeCloudRecentAgents(false, {
        refreshToken: "refresh-token",
        env: {},
      }),
    ).toBe(false);
  });

  test("returns false when no cloud credentials exist", () => {
    expect(
      shouldIncludeCloudRecentAgents(true, {
        refreshToken: undefined,
        env: {},
      }),
    ).toBe(false);
  });

  test("returns true when a refresh token exists", () => {
    expect(
      shouldIncludeCloudRecentAgents(true, {
        refreshToken: "refresh-token",
        env: {},
      }),
    ).toBe(true);
  });

  test("returns true when an API key exists", () => {
    expect(
      shouldIncludeCloudRecentAgents(true, {
        refreshToken: undefined,
        env: { LETTA_API_KEY: "sk-test" },
      }),
    ).toBe(true);
  });
});
