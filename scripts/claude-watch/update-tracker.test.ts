import { describe, expect, test } from "bun:test";
import { parseArgs } from "./update-tracker.ts";

describe("parseArgs", () => {
  const required = [
    "--tracker-issue",
    "123",
    "--analysis-file",
    "/tmp/analysis.json",
    "--state-commit-sha",
    "abc123",
    "--outcome",
    "pr_created",
    "--pr-url",
    "https://github.com/letta-ai/letta-code/pull/456",
  ];

  test("requires the expected GitHub login for a PR", () => {
    expect(() => parseArgs(required)).toThrow(
      "--expected-github-login is required for pr_created",
    );
  });

  test("accepts the expected GitHub login for a PR", () => {
    expect(
      parseArgs([...required, "--expected-github-login", "amelia-letta"])
        .expectedGithubLogin,
    ).toBe("amelia-letta");
  });
});
