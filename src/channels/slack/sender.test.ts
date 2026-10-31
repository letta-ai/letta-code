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

const CRON_PROMPT_AUTONOMOUS_NOTICE =
  "You are running autonomously: no user is watching this turn and questions will not be answered. Deliver results through your available channels or record them in memory, and work until the task is done or genuinely blocked.";
const FULL_SCHEDULED_PROMPT_LABEL = "*Full scheduled prompt:*\n";

type TestSlackSectionBlock = {
  type: "section";
  expand?: boolean;
  text: { type: "mrkdwn" | "plain_text"; text: string };
};

function buildTestCronPrompt(prompt: string): string {
  return [
    'Scheduled task "Daily status" is firing.',
    "Description: Post the morning status to Slack.",
    "Timezone: UTC",
    "Scheduled for: 2026-04-11T09:00:00.000+00:00[UTC]",
    "Current time: 2026-04-11T09:00:03.000+00:00[UTC]",
    "This is fire #3 (cron: * * * * *).",
    "",
    CRON_PROMPT_AUTONOMOUS_NOTICE,
    "",
    `Prompt: ${prompt}`,
  ].join("\n");
}

function escapeSlackMrkdwnForTest(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function scheduledSectionBlocks(
  blocks: unknown[] | undefined,
): TestSlackSectionBlock[] {
  return (blocks ?? []).filter(
    (block): block is TestSlackSectionBlock =>
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "section",
  );
}

function renderedScheduledPrompt(blocks: unknown[] | undefined): string {
  const promptSections = scheduledSectionBlocks(blocks).slice(1);
  return promptSections
    .map((block, index) => {
      const text = block.text.text;
      return index === 0
        ? text.slice(FULL_SCHEDULED_PROMPT_LABEL.length)
        : text;
    })
    .join("");
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

  test("uses Slack reply blocks with web footnote for cloud agent responses", async () => {
    const client = new FakeSlackSenderClient();
    const sender = createSlackChannelSender({ client });
    const message: OutboundChannelMessage = {
      channel: "slack",
      accountId: "integration-1",
      chatId: "C123",
      threadId: "1712790000.000000",
      text: "hello from cloud",
      agentId: "agent-123",
      conversationId: "conversation-456",
    };

    await expect(sender.sendMessage(message)).resolves.toEqual({
      messageId: "1712790000.000050",
    });
    expect(client.postMessages).toEqual([
      {
        channel: "C123",
        text: "hello from cloud",
        threadTs: "1712790000.000000",
        blocks: [
          {
            type: "markdown",
            text: "hello from cloud",
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: "<https://chat.letta.com/chat/agent-123?conversation=conversation-456|View on web>",
              },
            ],
          },
        ],
      },
    ]);
  });

  test("renders cron prompts as compact scheduled blocks", async () => {
    const client = new FakeSlackSenderClient();
    const sender = createSlackChannelSender({ client });
    const scheduledPrompt =
      "Check the incident queue, summarize the top risks, and post the update.";
    const cronPrompt = buildTestCronPrompt(scheduledPrompt);
    const message: OutboundChannelMessage = {
      channel: "slack",
      accountId: "integration-1",
      chatId: "C123",
      threadId: "1712790000.000000",
      text: cronPrompt,
      agentId: "agent-123",
      conversationId: "conversation-456",
    };

    await sender.sendMessage(message);

    expect(client.postMessages[0]?.text).toBe(
      [
        "Scheduled task fired: Daily status",
        "Fire #3 · cron * * * * *",
        "Scheduled for: 2026-04-11T09:00:00.000+00:00[UTC]",
        "Prompt: Check the incident queue, summarize the top risks, and post the update.",
      ].join("\n"),
    );
    expect(client.postMessages[0]?.blocks).toEqual([
      {
        type: "section",
        expand: false,
        text: {
          type: "mrkdwn",
          text: [
            ":calendar: *Scheduled task fired*",
            "*Daily status*",
            "Post the morning status to Slack.",
            "Fire #3 · cron `* * * * *`",
            ":clock1: Scheduled for `2026-04-11T09:00:00.000+00:00[UTC]`",
          ].join("\n"),
        },
      },
      {
        type: "section",
        expand: false,
        text: {
          type: "mrkdwn",
          text: `${FULL_SCHEDULED_PROMPT_LABEL}${scheduledPrompt}`,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "<https://chat.letta.com/chat/agent-123?conversation=conversation-456|View full scheduled prompt>",
          },
        ],
      },
    ]);
    expect(client.postMessages[0]?.text).not.toContain(
      "You are running autonomously",
    );
    expect(JSON.stringify(client.postMessages[0]?.blocks)).not.toContain(
      "You are running autonomously",
    );
    expect(JSON.stringify(client.postMessages[0]?.blocks)).not.toContain(
      "Description:",
    );
  });

  test("renders cron prompts as scheduled blocks without web identity", async () => {
    const client = new FakeSlackSenderClient();
    const sender = createSlackChannelSender({ client });
    const scheduledPrompt = "Post a concise heartbeat.";

    await sender.sendMessage({
      channel: "slack",
      accountId: "integration-1",
      chatId: "C123",
      text: buildTestCronPrompt(scheduledPrompt),
    });

    expect(client.postMessages[0]?.text).toBe(
      [
        "Scheduled task fired: Daily status",
        "Fire #3 · cron * * * * *",
        "Scheduled for: 2026-04-11T09:00:00.000+00:00[UTC]",
        "Prompt: Post a concise heartbeat.",
      ].join("\n"),
    );
    expect(client.postMessages[0]?.blocks).toEqual([
      expect.objectContaining({ type: "section", expand: false }),
      {
        type: "section",
        expand: false,
        text: {
          type: "mrkdwn",
          text: `${FULL_SCHEDULED_PROMPT_LABEL}${scheduledPrompt}`,
        },
      },
    ]);
  });

  test("renders full long cron prompts in expandable section chunks", async () => {
    const client = new FakeSlackSenderClient();
    const sender = createSlackChannelSender({ client });
    const longPrompt = [
      "Inspect & report <all> blockers.",
      "x".repeat(3_100),
      "Finish with > done.",
    ].join("\n");

    await sender.sendMessage({
      channel: "slack",
      accountId: "integration-1",
      chatId: "C123",
      text: buildTestCronPrompt(longPrompt),
      agentId: "agent-123",
      conversationId: "conversation-456",
    });

    const payload = client.postMessages[0];
    const sections = scheduledSectionBlocks(payload?.blocks);
    const promptSections = sections.slice(1);
    expect(sections.length).toBeGreaterThan(2);
    expect(sections.every((section) => section.expand === false)).toBe(true);
    expect(sections.every((section) => section.text.text.length <= 3_000)).toBe(
      true,
    );
    expect(
      promptSections[0]?.text.text.startsWith(FULL_SCHEDULED_PROMPT_LABEL),
    ).toBe(true);
    expect(renderedScheduledPrompt(payload?.blocks)).toBe(
      escapeSlackMrkdwnForTest(longPrompt),
    );
    expect(payload?.text).toContain("Scheduled task fired: Daily status");
    expect(payload?.text).toContain("Prompt: Inspect & report <all> blockers.");
    expect(payload?.text).toContain("...");
    expect(payload?.text.length).toBeLessThan(600);
  });

  test("keeps malformed cron-looking messages on normal Slack blocks", async () => {
    const client = new FakeSlackSenderClient();
    const sender = createSlackChannelSender({ client });
    const malformedCronPrompt = [
      'Scheduled task "Daily status" is firing.',
      "Scheduled for: 2026-04-11T09:00:00.000+00:00[UTC]",
      "Prompt: Missing the rest of the cron prompt envelope.",
    ].join("\n");

    await sender.sendMessage({
      channel: "slack",
      accountId: "integration-1",
      chatId: "C123",
      text: malformedCronPrompt,
      agentId: "agent-123",
      conversationId: "conversation-456",
    });

    expect(client.postMessages[0]?.text).toBe(malformedCronPrompt);
    expect(client.postMessages[0]?.blocks).toEqual([
      {
        type: "markdown",
        text: malformedCronPrompt,
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "<https://chat.letta.com/chat/agent-123?conversation=conversation-456|View on web>",
          },
        ],
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
