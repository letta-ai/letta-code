import { describe, expect, test } from "bun:test";
import { shouldIncludeConstellationRecentAgents } from "@/cli/helpers/recent-agent-options";

describe("shouldIncludeConstellationRecentAgents", () => {
  test("returns false when constellation fetch is disabled", () => {
    expect(
      shouldIncludeConstellationRecentAgents(false, {
        refreshToken: "refresh-token",
        env: {},
      }),
    ).toBe(false);
  });

  test("returns false when no cloud credentials exist", () => {
    expect(
      shouldIncludeConstellationRecentAgents(true, {
        refreshToken: undefined,
        env: {},
      }),
    ).toBe(false);
  });

  test("returns true when a refresh token exists", () => {
    expect(
      shouldIncludeConstellationRecentAgents(true, {
        refreshToken: "refresh-token",
        env: {},
      }),
    ).toBe(true);
  });

  test("returns true when an API key exists", () => {
    expect(
      shouldIncludeConstellationRecentAgents(true, {
        refreshToken: undefined,
        env: { LETTA_API_KEY: "sk-test" },
      }),
    ).toBe(true);
  });
});
