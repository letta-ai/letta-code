import { expect, test } from "bun:test";
import { resolveSlackMessageText } from "../../channels/slack/media";

test("resolveSlackMessageText includes quoted attachment text", () => {
  expect(
    resolveSlackMessageText({
      text: "<@U999>",
      attachments: [
        {
          title: "Forwarded from Amy",
          text: "Can you ask the agent to look at this failure?",
          fallback: "Can you ask the agent to look at this failure?",
        },
      ],
    }),
  ).toBe(
    "<@U999>\n\nForwarded from Amy\n\nCan you ask the agent to look at this failure?",
  );
});

test("resolveSlackMessageText uses attachment block text when top-level text is empty", () => {
  expect(
    resolveSlackMessageText({
      attachments: [
        {
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "Quoted message from a forwarded Slack link",
              },
            },
          ],
        },
      ],
    }),
  ).toBe("Quoted message from a forwarded Slack link");
});
