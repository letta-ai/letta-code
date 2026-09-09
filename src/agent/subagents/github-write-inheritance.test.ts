import { expect, test } from "bun:test";
import { composeSubagentChildEnv } from "./subagent-launcher";

test("only an explicitly delegated task inherits GitHub authority", () => {
  const base = {
    parentProcessEnv: {
      LETTA_GITHUB_WRITE_CAPABILITY: "ambient",
      LETTA_SUBAGENT_GITHUB_WRITE_CAPABILITY: "old",
    },
    parentAgentId: "parent",
    launchProfile: undefined,
    inheritedPrimaryRoot: null,
  };
  const child = composeSubagentChildEnv({
    ...base,
    githubWriteCapability: "current-human",
  });
  expect(child.LETTA_SUBAGENT_GITHUB_WRITE_CAPABILITY).toBe("current-human");
  expect(child.LETTA_GITHUB_WRITE_CAPABILITY).toBeUndefined();
  const autonomous = composeSubagentChildEnv(base);
  expect(autonomous.LETTA_SUBAGENT_GITHUB_WRITE_CAPABILITY).toBeUndefined();
  const memory = composeSubagentChildEnv({
    ...base,
    githubWriteCapability: "current-human",
    launchProfile: "memory-subagent",
  });
  expect(memory.LETTA_SUBAGENT_GITHUB_WRITE_CAPABILITY).toBeUndefined();
});
