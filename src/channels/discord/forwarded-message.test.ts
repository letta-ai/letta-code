import { describe, expect, test } from "bun:test";
import { resolveDiscordInboundPayload } from "./forwarded-message";
import type { DiscordAttachmentLike } from "./internal-types";

function createAttachment(id: string): DiscordAttachmentLike {
  return {
    id,
    name: `${id}.txt`,
    contentType: "text/plain",
    size: 12,
    url: `https://cdn.discordapp.com/${id}.txt`,
  };
}

describe("resolveDiscordInboundPayload", () => {
  test("leaves ordinary Discord messages unchanged", () => {
    const attachment = createAttachment("ordinary");

    const payload = resolveDiscordInboundPayload({
      content: "ordinary message",
      attachments: new Map([[attachment.id, attachment]]),
    });

    expect(payload.text).toBe("ordinary message");
    expect(Array.from(payload.attachments.keys())).toEqual(["ordinary"]);
  });

  test("combines a forwarding note with snapshot content", () => {
    const payload = resolveDiscordInboundPayload({
      content: "Please investigate this",
      attachments: new Map(),
      reference: { type: 1 },
      messageSnapshots: new Map([
        [
          "source-message",
          {
            content: "The original report",
            attachments: new Map(),
          },
        ],
      ]),
    });

    expect(payload.text).toBe(
      "Please investigate this\n\nForwarded message:\nThe original report",
    );
  });

  test("merges attachments from the forwarding envelope and snapshot", () => {
    const envelopeAttachment = createAttachment("envelope");
    const forwardedAttachment = createAttachment("forwarded");

    const payload = resolveDiscordInboundPayload({
      content: "",
      attachments: new Map([[envelopeAttachment.id, envelopeAttachment]]),
      reference: { type: 1 },
      messageSnapshots: new Map([
        [
          "source-message",
          {
            content: "",
            attachments: new Map([
              [forwardedAttachment.id, forwardedAttachment],
            ]),
          },
        ],
      ]),
    });

    expect(payload.text).toBe("Forwarded message");
    expect(Array.from(payload.attachments.keys())).toEqual([
      "envelope",
      "forwarded",
    ]);
  });
});
