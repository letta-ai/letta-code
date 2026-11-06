import { expect, test } from "bun:test";
import { ACTING_USER_ID_ENV } from "@/agent/acting-user";
import { composeSubagentChildEnv } from "@/agent/subagents/subagent-launcher";
import { buildAgentSendReminder } from "@/backend/api/agent-message";
import { consumeSubagentLaunch } from "@/utils/subagent-launch-marker";
import {
  isLaunchSubagentCommand,
  toSubagentLaunchArgs,
} from "@/websocket/listener/subagent-protocol-inbound";
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

test("message replies survive launch validation and child environment composition", () => {
  for (const replyViaMessage of [true, false, undefined]) {
    const command = {
      type: "launch_subagent",
      request_id: "request-launch",
      runtime: { agent_id: "agent-parent", conversation_id: "conv-parent" },
      args: {
        subagent_type: "custom",
        prompt: "Send output to another channel",
        description: "Worker",
        ...(replyViaMessage !== undefined && {
          reply_via_message: replyViaMessage,
        }),
      },
    };
    expect(isLaunchSubagentCommand(command)).toBe(true);
    if (!isLaunchSubagentCommand(command)) throw new Error("Launch rejected");
    const args = toSubagentLaunchArgs(command.args);
    const env = composeSubagentChildEnv({
      parentProcessEnv: { LETTA_SUBAGENT_REPLY_VIA_MESSAGE: "1" },
      parentAgentId: command.runtime.agent_id,
      parentConversationId: command.runtime.conversation_id,
      replyViaMessage: args.reply_via_message,
      launchProfile: "default",
      inheritedPrimaryRoot: null,
    });
    const reminder = buildHeadlessSenderReminder(
      consumeSubagentLaunch(env),
      undefined,
      env,
    );
    expect(reminder).toBe(
      buildAgentSendReminder(
        { agentId: "agent-parent", conversationId: "conv-parent" },
        replyViaMessage === true,
      ),
    );
    if (replyViaMessage) {
      expect(reminder).toContain(
        "Ordinary assistant output is not forwarded to the sender.",
      );
      expect(reminder).not.toContain(
        "Include your answer in your final response",
      );
    }
  }
  expect(
    isLaunchSubagentCommand({
      type: "launch_subagent",
      request_id: "request-invalid",
      runtime: { agent_id: "agent-parent", conversation_id: "conv-parent" },
      args: {
        prompt: "Work",
        description: "Worker",
        reply_via_message: "true",
      },
    }),
  ).toBe(false);
});
