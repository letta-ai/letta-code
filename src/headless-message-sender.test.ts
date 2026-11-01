import { expect, test } from "bun:test";
import { ACTING_USER_ID_ENV } from "@/agent/acting-user";
import { composeSubagentChildEnv } from "@/agent/subagents/subagent-launcher";
import { buildAgentSendReminder } from "@/backend/api/agent-message";
import { consumeSubagentLaunch } from "@/utils/subagent-launch-marker";
import { buildHeadlessSenderReminder } from "./headless-message-sender";

test("nested launches use the immediate parent scope without changing the acting user", () => {
  const inherited = {
    LETTA_PARENT_AGENT_ID: "agent-grandparent",
    LETTA_PARENT_CONVERSATION_ID: "conv-grandparent",
    AGENT_ID: "agent-unrelated",
    CONVERSATION_ID: "conv-unrelated",
    [ACTING_USER_ID_ENV]: "user-owner",
  };
  const env = composeSubagentChildEnv({
    parentProcessEnv: inherited,
    parentAgentId: "agent-parent",
    parentConversationId: "conv-parent",
    launchProfile: "default",
    inheritedPrimaryRoot: null,
  });
  expect(
    buildHeadlessSenderReminder(consumeSubagentLaunch(env), undefined, env),
  ).toBe(
    buildAgentSendReminder(
      { agentId: "agent-parent", conversationId: "conv-parent" },
      false,
    ),
  );
  expect(env[ACTING_USER_ID_ENV]).toBe("user-owner");
  // A CLI command run later by the child is not another launch from its parent.
  expect(
    buildHeadlessSenderReminder(consumeSubagentLaunch(env), undefined, env),
  ).toBe("");
  expect(inherited.LETTA_PARENT_AGENT_ID).toBe("agent-grandparent");
});

test("unknown parent scope never inherits a grandparent address", () => {
  const env = composeSubagentChildEnv({
    parentProcessEnv: {
      LETTA_PARENT_AGENT_ID: "agent-grandparent",
      LETTA_PARENT_CONVERSATION_ID: "conv-grandparent",
    },
    parentAgentId: undefined,
    launchProfile: "default",
    inheritedPrimaryRoot: null,
  });
  expect(env.LETTA_PARENT_CONVERSATION_ID).toBeUndefined();
  expect(buildHeadlessSenderReminder(true, undefined, env)).toBe("");
});

test("human prompts have no agent attribution and explicit CLI sends use the shared format", () => {
  expect(buildHeadlessSenderReminder(false, undefined, {})).toBe("");
  expect(buildHeadlessSenderReminder(false, "agent-sender", {})).toBe(
    buildAgentSendReminder({ agentId: "agent-sender" }, false),
  );
});

test("memory workers receive a silent task-log contract instead of a reply instruction", () => {
  const env = composeSubagentChildEnv({
    parentProcessEnv: {},
    parentAgentId: "agent-parent",
    parentConversationId: "conv-parent",
    subagentType: "memory",
    launchProfile: "memory-subagent",
    inheritedPrimaryRoot: "/memory",
  });
  const reminder = buildHeadlessSenderReminder(true, undefined, env);
  expect(reminder).toContain("Complete only the delegated memory assignment");
  expect(reminder).toContain("not sent to the primary agent or user");
  expect(reminder).not.toContain("Include your answer in your final response");
  expect(reminder).toStartWith("<system-reminder>");
  // The worker sentinel does not change explicit CLI sends made by a process.
  expect(buildHeadlessSenderReminder(false, "agent-sender", env)).toBe(
    buildAgentSendReminder({ agentId: "agent-sender" }, false),
  );
});

test("same-agent sends ask for a reply only when one is needed", () => {
  const sender = { agentId: "agent-a", conversationId: "conv-1" };
  const sameAgent = buildAgentSendReminder(sender, true, "agent-a");
  expect(sameAgent).toContain("another of your own conversations");
  expect(sameAgent).toContain("Do not send acknowledgments");
  expect(sameAgent).toContain("you can reply with SendAgentMessage");
  expect(sameAgent).not.toContain("To reply, call SendAgentMessage");
  const otherAgent = buildAgentSendReminder(sender, true, "agent-b");
  expect(otherAgent).not.toContain("another of your own conversations");
  expect(buildAgentSendReminder(sender, true)).toBe(otherAgent);
});
