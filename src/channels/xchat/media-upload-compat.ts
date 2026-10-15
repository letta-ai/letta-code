import type { XChatSdkAdapterLike } from "./runtime";

const patchedMediaClients = new WeakSet<object>();

function mediaUploadConversationId(conversationId: string): string {
  if (conversationId.startsWith("g")) return conversationId;
  return /^\d+-\d+$/.test(conversationId)
    ? conversationId.replace("-", ":")
    : conversationId;
}

/**
 * Work around @chat-adapter/x 4.38.1 using dash-joined direct-message IDs in
 * media upload bodies. X accepts those requests but stores no downloadable
 * blob. Remove this shim after the upstream package uses colon-joined IDs.
 */
export function patchXChatMediaUploadConversationIds(
  sdkAdapter: XChatSdkAdapterLike,
): void {
  const chat = sdkAdapter.getXdkClient?.().chat;
  if (!chat || patchedMediaClients.has(chat)) return;
  patchedMediaClients.add(chat);

  const initialize = chat.mediaUploadInitialize?.bind(chat);
  if (initialize) {
    chat.mediaUploadInitialize = (body) =>
      initialize({
        ...body,
        conversationId: mediaUploadConversationId(body.conversationId),
      });
  }
  const append = chat.mediaUploadAppend?.bind(chat);
  if (append) {
    chat.mediaUploadAppend = (sessionId, body) =>
      append(sessionId, {
        ...body,
        conversationId: mediaUploadConversationId(body.conversationId),
      });
  }
  const finalize = chat.mediaUploadFinalize?.bind(chat);
  if (finalize) {
    chat.mediaUploadFinalize = (sessionId, body) =>
      finalize(sessionId, {
        ...body,
        conversationId: mediaUploadConversationId(body.conversationId),
      });
  }
}
