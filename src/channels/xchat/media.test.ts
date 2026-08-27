import { expect, test } from "bun:test";
import { describeXChatAttachments, inferXChatUploadMimeType } from "./media";

test("describes inbound attachments without downloading unbounded media", () => {
  let fetched = false;
  const attachments = describeXChatAttachments("message-1", [
    {
      type: "image",
      name: "avatar.png",
      size: 4,
      fetchData: async () => {
        fetched = true;
        return Buffer.from("test");
      },
    },
  ]);

  expect(fetched).toBe(false);
  expect(attachments).toEqual([
    {
      id: "message-1:0",
      name: "avatar.png",
      mimeType: undefined,
      sizeBytes: 4,
      kind: "image",
      sourceMessageId: "message-1",
    },
  ]);
});

test("infers MIME types for common outbound media", () => {
  expect(inferXChatUploadMimeType("photo.png")).toBe("image/png");
  expect(inferXChatUploadMimeType("document.pdf")).toBe("application/pdf");
  expect(inferXChatUploadMimeType("archive.bin")).toBeUndefined();
});
