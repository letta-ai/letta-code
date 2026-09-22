import { describe, expect, test } from "bun:test";
import { isAppServerInfoResponseMessage } from "@/types/app-server-info";
import { buildAppServerInfoResponse } from "./commands/app-server-info";
import { parseServerMessage } from "./protocol-inbound";
import { isLaunchSubagentCommand } from "./subagent-protocol-inbound";

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
  test.each([
    { request_id: "" },
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
  ])("rejects malformed or injected launch fields %j", (fields) => {
    expect(isLaunchSubagentCommand({ ...command, ...fields })).toBe(false);
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
