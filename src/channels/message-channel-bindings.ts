/** Persisted inbound routing state, supplied by the host that owns the route. */
export interface ChannelConversationBinding {
  conversationId: string;
  enabled: boolean;
  outboundEnabled: boolean;
  detached: boolean;
}

export interface ChannelBindingSelection {
  channel: string;
  accountId?: string;
  chatId: string;
  threadId: string | null;
}

export interface ChannelBindingLookup extends ChannelBindingSelection {
  accountId: string;
  binding: ChannelConversationBinding | null;
}

export interface ChannelBindingUpdate extends ChannelBindingLookup {
  status: "updated" | "unchanged" | "conflict" | "not-found";
  previousConversationId: string | null;
}

export interface MessageChannelBindingOperations {
  get(
    selection: ChannelBindingSelection,
    scope: { agentId: string; conversationId: string },
  ): Promise<ChannelBindingLookup>;
  update(
    selection: ChannelBindingSelection & {
      conversationId: string;
      expectedConversationId: string;
    },
    scope: { agentId: string; conversationId: string },
  ): Promise<ChannelBindingUpdate>;
}

export type ChannelSendBindingInfo =
  | ChannelBindingLookup
  | { unavailable: true };

export function formatSlackBindingNotice(
  info: ChannelSendBindingInfo | undefined,
  conversationId: string,
): string {
  if (!info) return "";
  if ("unavailable" in info) {
    return "\nThe message was delivered, but its thread binding could not be checked.";
  }
  if (!info.binding) return "\nThis thread has no incoming-message binding.";
  const binding = info.binding;
  const state = binding.detached
    ? `This thread is detached (binding: ${binding.conversationId}).`
    : !binding.enabled
      ? `Incoming replies are paused for this thread (binding: ${binding.conversationId}).`
      : binding.conversationId === conversationId
        ? `Replies in this thread go to this conversation (${conversationId}).`
        : `Replies in this thread currently go to ${binding.conversationId}; this conversation is ${conversationId}.`;
  if (binding.conversationId === conversationId) return `\n${state}`;
  const action = {
    action: "update-binding",
    channel: info.channel,
    accountId: info.accountId,
    chat_id: info.chatId,
    threadId: info.threadId,
    conversationId,
    expectedConversationId: binding.conversationId,
  };
  return `\n${state}\nTo change this thread's destination to this conversation, call MessageChannel with ${JSON.stringify(action)}. Existing pause/detach settings are preserved.`;
}
