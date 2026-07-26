import { describe, expect, test } from "bun:test";
import {
  isCronAddCommand,
  isCronUpdateCommand,
} from "@/websocket/listener/protocol-inbound-cron";

describe("cron channel target protocol", () => {
  test("accepts valid cron channel targets and rejects invalid ones", () => {
    expect(
      isCronAddCommand({
        type: "cron_add",
        request_id: "cron-add-1",
        agent_id: "agent-1",
        conversation_id: "default",
        name: "Test task",
        description: "A test cron task",
        channel_targets: [
          {
            channel_id: "discord",
            account_id: "acct-1",
            chat_id: "chat-1",
            label: "Ops room",
          },
        ],
        cron: "*/5 * * * *",
        recurring: true,
        prompt: "hello",
      }),
    ).toBe(true);

    expect(
      isCronUpdateCommand({
        type: "cron_update",
        request_id: "cron-update-1",
        task_id: "cron-1",
        channel_targets: [],
      }),
    ).toBe(true);

    expect(
      isCronAddCommand({
        type: "cron_add",
        request_id: "cron-add-bad-1",
        agent_id: "agent-1",
        conversation_id: "default",
        name: "Bad cron",
        description: "Bad target",
        channel_targets: [{ channel_id: "discord", chat_id: "" }],
        cron: "*/5 * * * *",
        recurring: true,
        prompt: "hello",
      }),
    ).toBe(false);

    expect(
      isCronUpdateCommand({
        type: "cron_update",
        request_id: "cron-update-bad-1",
        task_id: "cron-1",
        channel_targets: [
          {
            channel_id: "unsupported-channel",
            chat_id: "chat-1",
          },
        ],
      }),
    ).toBe(false);
  });
});
