import { describe, expect, test } from "bun:test";
import { isAppServerInfoResponseMessage } from "@/types/app-server-info";
import { buildAppServerInfoResponse } from "./commands/app-server-info";
import { parseServerMessage } from "./protocol-inbound";
import {
  isLaunchSubagentCommand,
  isSubagentMessageCommand,
  isSubagentStopCommand,
  toSubagentLaunchArgs,
} from "./subagent-protocol-inbound";

const command = {
  type: "launch_subagent" as const,
  request_id: "launch-1",
  runtime: {
    agent_id: "agent-parent",
    conversation_id: "conv-parent",
    acting_user_id: "user-owner",
  },
  args: {
    subagent_type: "custom",
    conversation_id: "conv-child",
    description: "Child task",
    prompt: "Do the work",
    computer: "cloud",
  },
};

describe("launch_subagent protocol", () => {
  test("parses the command with explicit parent and independent child", () => {
    expect(parseServerMessage(Buffer.from(JSON.stringify(command)))).toEqual(
      command,
    );
  });
  test.each([undefined, "assignment:initial-input"])(
    "accepts optional initial client_message_id %s independently of request_id",
    (client_message_id) => {
      const input = {
        ...command,
        args: { ...command.args, client_message_id },
      };
      expect(isLaunchSubagentCommand(input)).toBe(true);
      expect(parseServerMessage(Buffer.from(JSON.stringify(input)))).toEqual(
        input,
      );
    },
  );
  test.each([
    { request_id: "" },
    { args: { ...command.args, client_message_id: "" } },
    { args: { ...command.args, client_message_id: "  " } },
    { args: { ...command.args, client_message_id: 42 } },
    { args: { ...command.args, client_message_id: null } },
    { runtime: null },
    { runtime: { agent_id: null, conversation_id: "conv-parent" } },
    { runtime: { ...command.runtime, acting_user_id: 42 } },
    { args: null },
    { args: [] },
    { args: { ...command.args, prompt: "" } },
    { args: { ...command.args, computer: 3 } },
    { args: { ...command.args, max_turns: 1.5 } },
    { args: { ...command.args, max_turns: -1 } },
    { args: { ...command.args, parentScope: { agentId: "someone-else" } } },
    { args: { ...command.args, command: "refresh" } },
    { tool_call_id: 1 },
    { notify: "self" },
    { args: { ...command.args, mcp: [] } },
    { args: { ...command.args, notifyCaller: true } },
    { args: { ...command.args, harness: "" } },
    { args: { ...command.args, harness: 3 } },
    { args: { ...command.args, subagent_type: "  " } },
    { args: { ...command.args, fork_context: "true" } },
    { args: { ...command.args, agent_type: "custom" } },
  ])("rejects malformed or injected launch fields %j", (fields) => {
    expect(isLaunchSubagentCommand({ ...command, ...fields })).toBe(false);
  });
  test.each([
    { harness: "codex", fork_context: true },
    { harness: "letta", subagent_type: "recall" },
    { subagent_type: "custom", fork_context: false },
  ])("accepts the current selection fields %j", (selection) => {
    const { subagent_type: _legacy, ...args } = command.args;
    expect(
      isLaunchSubagentCommand({ ...command, args: { ...args, ...selection } }),
    ).toBe(true);
  });
  test.each([
    // An older client: only subagent_type, with its original meaning.
    [{ subagent_type: "custom" }, { subagent_type: "custom" }],
    [{ subagent_type: "recall" }, { subagent_type: "recall" }],
    [{ subagent_type: " my-reviewer " }, { subagent_type: "my-reviewer" }],
    [{ subagent_type: "codex" }, { harness: "codex", fork_context: false }],
    [
      { subagent_type: "claude-code" },
      { harness: "claude-code", fork_context: false },
    ],
    [{ subagent_type: "cursor" }, { harness: "cursor", fork_context: false }],
    [
      { subagent_type: "opencode" },
      { harness: "opencode", fork_context: false },
    ],
    [{ subagent_type: "general-purpose" }, { fork_context: false }],
    [{ subagent_type: "fork" }, { fork_context: true }],
    // A current client: harness or fork_context present, passed through.
    [
      { harness: "codex", fork_context: false },
      { harness: "codex", fork_context: false },
    ],
    [
      { harness: "letta", subagent_type: "recall" },
      { harness: "letta", subagent_type: "recall" },
    ],
    [
      { subagent_type: "fork", fork_context: true },
      { subagent_type: "fork", fork_context: true },
    ],
    [{}, {}],
  ])("maps wire selection %j onto Agent launch args", (wire, launch) => {
    const base = { prompt: "Do the work", description: "Child task" };
    expect(toSubagentLaunchArgs({ ...base, ...wire })).toEqual({
      ...base,
      ...launch,
    });
  });
  test("accepts caller notification and an MCP selection", () => {
    const input = {
      ...command,
      tool_call_id: "call-1",
      notify: "caller",
      args: { ...command.args, mcp: { inherit: false } },
    };
    expect(isLaunchSubagentCommand(input)).toBe(true);
  });
  test("clients can distinguish older servers without rejecting their info response", () => {
    const info = buildAppServerInfoResponse(
      { type: "app_server_info", request_id: "info" },
      { backend: "local", version: "test" },
    );
    expect(isAppServerInfoResponseMessage(info)).toBe(true);
    delete info.capabilities.launch_subagent;
    expect(isAppServerInfoResponseMessage(info)).toBe(true);
    expect(info.capabilities.launch_subagent === true).toBe(false);
    expect(
      isAppServerInfoResponseMessage({
        ...info,
        capabilities: { ...info.capabilities, launch_subagent: "yes" },
      }),
    ).toBe(false);
  });
});

describe("subagent control protocol", () => {
  const base = {
    request_id: "request-1",
    runtime: { agent_id: "agent-parent", conversation_id: "conv-parent" },
    agent_id: "claude_11111111-1111-4111-8111-111111111111",
  };

  test("accepts valid message and stop commands", () => {
    expect(
      isSubagentMessageCommand({
        ...base,
        type: "subagent_message",
        message: "Continue",
        tool_call_id: "call-2",
      }),
    ).toBe(true);
    expect(isSubagentStopCommand({ ...base, type: "subagent_stop" })).toBe(
      true,
    );
  });

  test.each([
    { request_id: "" },
    { agent_id: "" },
    { runtime: { agent_id: "", conversation_id: "conv-parent" } },
    { message: "" },
    { tool_call_id: 42 },
  ])("rejects invalid message commands %#", (override) => {
    expect(
      isSubagentMessageCommand({
        ...base,
        type: "subagent_message",
        message: "Continue",
        ...override,
      }),
    ).toBe(false);
  });
});
