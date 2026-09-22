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
  ])("rejects malformed or injected launch fields %j", (fields) => {
    expect(isLaunchSubagentCommand({ ...command, ...fields })).toBe(false);
  });
  test.each(["local", "api"] as const)(
    "clients can detect initial client message ID support independently of launch support (%s)",
    (backend) => {
      const info = buildAppServerInfoResponse(
        { type: "app_server_info", request_id: "info" },
        { backend, version: "test" },
      );
      expect(isAppServerInfoResponseMessage(info)).toBe(true);
      // Only a Cloud input destination accepts --client-message-id, so a
      // local listener keeps launch support without the identity capability.
      expect(info.capabilities.launch_subagent_client_message_id).toBe(
        backend === "api",
      );
      delete info.capabilities.launch_subagent_client_message_id;
      expect(info.capabilities.launch_subagent).toBe(true);
      expect(isAppServerInfoResponseMessage(info)).toBe(true);
      expect(info.capabilities.launch_subagent_client_message_id === true).toBe(
        false,
      );
      for (const value of [false, true, "yes", null, 1]) {
        expect(
          isAppServerInfoResponseMessage({
            ...info,
            capabilities: {
              ...info.capabilities,
              launch_subagent_client_message_id: value,
            },
          }),
        ).toBe(typeof value === "boolean");
      }
    },
  );
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
