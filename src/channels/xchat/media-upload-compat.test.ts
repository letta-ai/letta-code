import { expect, test } from "bun:test";
import { patchXChatMediaUploadConversationIds } from "./media-upload-compat";
import type { XChatApiClientLike, XChatSdkAdapterLike } from "./runtime";

test("normalizes only numeric direct-message IDs for media uploads", async () => {
  const conversationIds: string[] = [];
  const apiClient: XChatApiClientLike = {
    chat: {
      getConversations: async () => ({ data: [] }),
      mediaUploadInitialize: async (body) => {
        conversationIds.push(body.conversationId);
      },
      mediaUploadAppend: async (_sessionId, body) => {
        conversationIds.push(body.conversationId);
      },
      mediaUploadFinalize: async (_sessionId, body) => {
        conversationIds.push(body.conversationId);
      },
    },
    users: {
      getMe: async () => ({ data: {} }),
      getPublicKey: async () => ({ data: [] }),
    },
  };
  const sdkAdapter = {
    getXdkClient: () => apiClient,
  } as XChatSdkAdapterLike;

  patchXChatMediaUploadConversationIds(sdkAdapter);
  await apiClient.chat.mediaUploadInitialize?.({
    conversationId: "123-456",
    totalBytes: 1,
  });
  await apiClient.chat.mediaUploadAppend?.("session", {
    conversationId: "123-456",
    mediaHashKey: "hash",
    media: "AA==",
    segmentIndex: 0,
  });
  await apiClient.chat.mediaUploadFinalize?.("session", {
    conversationId: "123-456",
    mediaHashKey: "hash",
    numParts: "1",
  });
  await apiClient.chat.mediaUploadInitialize?.({
    conversationId: "g-group",
    totalBytes: 1,
  });
  await apiClient.chat.mediaUploadInitialize?.({
    conversationId: "dm-conversation",
    totalBytes: 1,
  });

  expect(conversationIds).toEqual([
    "123:456",
    "123:456",
    "123:456",
    "g-group",
    "dm-conversation",
  ]);
});
