import { expect, test } from "bun:test";
import {
  LISTENER_CONNECTION_ENV,
  SUBAGENT_LAUNCH_PROFILE_ENV,
} from "@/utils/subagent-launch-marker";
import {
  composeSubagentChildEnv,
  shouldLaunchThroughListener,
} from "./subagent-launcher";

test("ordinary children use the existing listener and preserve local execution without one", () => {
  expect(
    shouldLaunchThroughListener({
      cloudBackend: true,
      connectionId: "conn-parent",
      launchProfile: "default",
    }),
  ).toBe(true);
  expect(
    shouldLaunchThroughListener({ cloudBackend: true, computer: "cloud" }),
  ).toBe(true);
  expect(
    shouldLaunchThroughListener({
      cloudBackend: false,
      connectionId: "conn-parent",
    }),
  ).toBe(false);
  expect(shouldLaunchThroughListener({ cloudBackend: true })).toBe(false);
  expect(
    shouldLaunchThroughListener({ cloudBackend: false, computer: "remote" }),
  ).toBe(true);
});

test("ephemeral launches stay local and reject explicit computer routing", () => {
  expect(
    shouldLaunchThroughListener({
      cloudBackend: true,
      connectionId: "conn-parent",
      ephemeral: true,
    }),
  ).toBe(false);
  expect(() =>
    shouldLaunchThroughListener({
      cloudBackend: true,
      computer: "cloud",
      ephemeral: true,
    }),
  ).toThrow("Ephemeral conversations");
});

test("memory workers remain confined processes, without an inherited listener route", () => {
  const env = composeSubagentChildEnv({
    parentProcessEnv: { [LISTENER_CONNECTION_ENV]: "conn-parent" },
    subagentType: "memory",
    parentAgentId: "agent-parent",
    launchProfile: "memory-subagent",
    inheritedPrimaryRoot: "/memory",
  });
  expect(env[LISTENER_CONNECTION_ENV]).toBeUndefined();
  expect(env[SUBAGENT_LAUNCH_PROFILE_ENV]).toBe("memory-subagent");
  expect(env.MEMORY_DIR).toBe("/memory");
  expect(
    shouldLaunchThroughListener({
      cloudBackend: true,
      connectionId: "conn-parent",
      launchProfile: "memory-subagent",
    }),
  ).toBe(false);
  expect(() =>
    shouldLaunchThroughListener({
      cloudBackend: true,
      computer: "cloud",
      launchProfile: "memory-subagent",
    }),
  ).toThrow("confined local process");
});

test("an ordinary child's caller routes it without changing the parent's environment", () => {
  const parentProcessEnv = { USER_CWD: "/workspace" };
  const env = composeSubagentChildEnv({
    parentProcessEnv,
    subagentType: "general-purpose",
    parentAgentId: "agent-parent",
    inheritedPrimaryRoot: null,
    launchProfile: "default",
    listenerConnectionId: "conn-parent",
  });
  expect(env[LISTENER_CONNECTION_ENV]).toBe("conn-parent");
  expect(parentProcessEnv).toEqual({ USER_CWD: "/workspace" });
});

test("nested children keep the root task's PR attribution conversation", () => {
  const topLevel = composeSubagentChildEnv({
    parentProcessEnv: {},
    subagentType: "general-purpose",
    parentAgentId: "agent-parent",
    parentConversationId: "conv-launcher",
    inheritedPrimaryRoot: null,
    launchProfile: "default",
  });
  const nested = composeSubagentChildEnv({
    parentProcessEnv: topLevel,
    subagentType: "general-purpose",
    parentAgentId: "agent-worker",
    parentConversationId: "conv-middle",
    inheritedPrimaryRoot: null,
    launchProfile: "default",
  });
  const nestedDefault = composeSubagentChildEnv({
    parentProcessEnv: nested,
    subagentType: "general-purpose",
    parentAgentId: "agent-worker-2",
    parentConversationId: "default",
    inheritedPrimaryRoot: null,
    launchProfile: "default",
  });

  expect(topLevel.LETTA_GITHUB_PR_CONVERSATION_IDS).toBe("conv-launcher");
  expect(nested.LETTA_GITHUB_PR_CONVERSATION_IDS).toBe(
    "conv-launcher,conv-middle",
  );
  expect(nestedDefault.LETTA_GITHUB_PR_CONVERSATION_IDS).toBe(
    "conv-launcher,conv-middle",
  );
});

test("default launch parents do not create an invalid PR attribution target", () => {
  const env = composeSubagentChildEnv({
    parentProcessEnv: {},
    subagentType: "general-purpose",
    parentAgentId: "agent-parent",
    parentConversationId: "default",
    inheritedPrimaryRoot: null,
    launchProfile: "default",
  });

  expect(env.LETTA_GITHUB_PR_CONVERSATION_IDS).toBeUndefined();
});
