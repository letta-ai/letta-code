import { describe, expect, test } from "bun:test";
import {
  getGithubWriteCapability,
  redactGithubWriteAuthority,
  takeGithubWriteCapability,
} from "./github-write-authority";
import { runWithRuntimeContext } from "./runtime-context";

describe("private GitHub authority", () => {
  test("extracts authority before acknowledgments or telemetry can echo it", () => {
    const frame = {
      type: "input",
      runtime: {
        agent_id: "agent",
        conversation_id: "conv",
        github_write_capability: "private-token",
      },
    };
    expect(takeGithubWriteCapability(frame)).toBe("private-token");
    expect(JSON.stringify(frame)).not.toContain("private-token");
    expect(takeGithubWriteCapability(frame)).toBeNull();
  });
  test("isolates concurrent tool scopes and explicitly clears autonomous work", async () => {
    const values = await Promise.all(
      ["alice", "bob", null].map((githubWriteCapability) =>
        runWithRuntimeContext({ githubWriteCapability }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          return getGithubWriteCapability();
        }),
      ),
    );
    expect(values).toEqual(["alice", "bob", null]);
    expect(getGithubWriteCapability()).toBeNull();
  });
  test("redacts malformed raw input and nested telemetry without modifying the frame", () => {
    const raw = '{"runtime":{"github_write_capability":"private-token"},';
    expect(redactGithubWriteAuthority(raw)).not.toContain("private-token");
    const frame = { runtime: { github_write_capability: "private-token" } };
    expect(JSON.stringify(redactGithubWriteAuthority(frame))).not.toContain(
      "private-token",
    );
    expect(frame.runtime.github_write_capability).toBe("private-token");
  });
});
