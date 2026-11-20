import { expect, mock, test } from "bun:test";
import type { AppServerClient } from "@/app-server-client";
import type { SubagentMessageCommand } from "@/types/subagent-protocol";
import { sendRemoteFollowUpWithReconnect } from "./remote-follow-up-retry";

const command: SubagentMessageCommand = {
  type: "subagent_message",
  request_id: "request-test",
  runtime: { agent_id: "agent-parent", conversation_id: "conv-parent" },
  agent_id: "claude_11111111-1111-4111-8111-111111111111",
  message: "Continue",
};

for (const message of [
  "App-server socket closed unexpectedly",
  "Permission denied",
  `Timed out waiting for ${command.request_id}`,
]) {
  test(`does not reconnect for ${message}`, async () => {
    const connect = mock(async () => {
      throw new Error("Unexpected reconnect");
    });
    const client = {
      sendSubagentMessage: async () => {
        throw new Error(message);
      },
    } as unknown as AppServerClient;
    await expect(
      sendRemoteFollowUpWithReconnect(
        client,
        command,
        connect,
        () => {},
        "computer",
      ),
    ).rejects.toThrow(
      message.startsWith("Timed out")
        ? "The message may not have been delivered"
        : message,
    );
    expect(connect).not.toHaveBeenCalled();
  });
}
