import { expect, test } from "bun:test";
import {
  LISTENER_CONNECTION_ENV,
  SUBAGENT_LAUNCH_PROFILE_ENV,
} from "@/utils/subagent-launch-marker";
import {
  composeSubagentChildEnv,
  resolveSubagentDeploymentAgentId,
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

test("ephemeral launches preserve inherited and explicit computer routing", () => {
  expect(
    shouldLaunchThroughListener({
      cloudBackend: true,
      connectionId: "conn-parent",
      ephemeral: true,
    }),
  ).toBe(true);
  expect(
    shouldLaunchThroughListener({
      cloudBackend: true,
      computer: "cloud",
      ephemeral: true,
    }),
  ).toBe(true);
  expect(
    shouldLaunchThroughListener({ cloudBackend: true, ephemeral: true }),
  ).toBe(false);
  expect(
    shouldLaunchThroughListener({
      cloudBackend: false,
      connectionId: "conn-parent",
      ephemeral: true,
    }),
  ).toBe(false);
});

test.each([false, true])(
  "memory workers remain confined processes (ephemeral: %s)",
  (ephemeral) => {
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
        ephemeral,
      }),
    ).toBe(false);
    expect(() =>
      shouldLaunchThroughListener({
        cloudBackend: true,
        computer: "cloud",
        launchProfile: "memory-subagent",
        ephemeral,
      }),
    ).toThrow("confined local process");
  },
);

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

test.each(["agent-owner", null])(
  "conv-only deployments resolve actual owner %s, never the resource parent",
  async (owner) => {
    const id = await resolveSubagentDeploymentAgentId(
      undefined,
      "conv-child",
      async (conversationId) => {
        expect(conversationId).toBe("conv-child");
        return { agent_id: owner, parent_agent_id: "agent-resource" };
      },
    );
    expect(id).toBe(owner ?? undefined);
  },
);

test("unknown parent scope clears stale resource and conversation addresses", () => {
  const env = composeSubagentChildEnv({
    parentProcessEnv: {
      LETTA_PARENT_AGENT_ID: "agent-stale",
      LETTA_PARENT_CONVERSATION_ID: "conv-stale",
    },
    parentAgentId: undefined,
    launchProfile: "default",
    inheritedPrimaryRoot: null,
  });
  expect(env.LETTA_PARENT_AGENT_ID).toBeUndefined();
  expect(env.LETTA_PARENT_CONVERSATION_ID).toBeUndefined();
});

test("nested ephemeral children preserve the inherited resource agent", () => {
  const env = composeSubagentChildEnv({
    parentProcessEnv: { LETTA_PARENT_AGENT_ID: "agent-resource" },
    parentAgentId: "conv-parent",
    launchProfile: "default",
    inheritedPrimaryRoot: null,
  });
  expect(env.LETTA_PARENT_AGENT_ID).toBe("agent-resource");
});
