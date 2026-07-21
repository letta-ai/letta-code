import { describe, expect, test } from "bun:test";
import type {
  SlackSenderPostMessageParams,
  SlackSenderPostMessageResult,
  SlackSenderReactionParams,
} from "@/channels/slack/sender";
import { createSlackChannelSender } from "@/channels/slack/sender";
import type { OutboundChannelMessage } from "@/channels/types";

class FakeSlackSenderClient {
  postMessages: SlackSenderPostMessageParams[] = [];
  addedReactions: SlackSenderReactionParams[] = [];
  removedReactions: SlackSenderReactionParams[] = [];

  async postMessage(
    params: SlackSenderPostMessageParams,
  ): Promise<SlackSenderPostMessageResult> {
    this.postMessages.push(params);
    return { messageId: "1712790000.000050" };
  }

  async addReaction(params: SlackSenderReactionParams): Promise<void> {
    this.addedReactions.push(params);
  }

  async removeReaction(params: SlackSenderReactionParams): Promise<void> {
    this.removedReactions.push(params);
  }
}

describe("Slack channel sender", () => {
  test("posts threaded channel messages", async () => {
    const client = new FakeSlackSenderClient();
    const sender = createSlackChannelSender({ client });
    const message: OutboundChannelMessage = {
      channel: "slack",
      accountId: "integration-1",
      chatId: "C123",
      threadId: "1712790000.000000",
      text: "hello",
    };

    await expect(sender.sendMessage(message)).resolves.toEqual({
      messageId: "1712790000.000050",
    });
    expect(client.postMessages).toEqual([
      {
        channel: "C123",
        text: "hello",
        threadTs: "1712790000.000000",
      },
    ]);
  });

  test("adds Slack reactions", async () => {
    const client = new FakeSlackSenderClient();
    const sender = createSlackChannelSender({ client });
    const message: OutboundChannelMessage = {
      channel: "slack",
      chatId: "C123",
      text: "",
      targetMessageId: "1712790000.000000",
      reaction: ":eyes:",
    };

    await expect(sender.sendMessage(message)).resolves.toEqual({
      messageId: "1712790000.000000",
    });
    expect(client.addedReactions).toEqual([
      {
        channel: "C123",
        timestamp: "1712790000.000000",
        name: "eyes",
      },
    ]);
  });
});
