import type { ApprovalResponseBody } from "@/types/protocol_v2";
import { LEGACY_CHANNEL_ACCOUNT_ID } from "./accounts";
import { parseChannelBangCommand, parseChannelSlashCommand } from "./commands";
import {
  formatChannelControlRequestPrompt,
  parseChannelControlRequestResponse,
} from "./interactive";
import {
  listPendingControlRequests as listPersistedPendingControlRequests,
  removePendingControlRequest as removePersistedPendingControlRequest,
  upsertPendingControlRequest as upsertPersistedPendingControlRequest,
} from "./pending-control-requests";
import { buildDirectReplyOptions } from "./registry-presentation";
import type {
  ChannelAdapter,
  ChannelControlRequestEvent,
  ChannelControlResponseInput,
  ChannelControlResponseResult,
  InboundChannelMessage,
} from "./types";

export type ChannelApprovalResponseHandler = (params: {
  runtime: {
    agent_id?: string | null;
    conversation_id?: string | null;
  };
  response: ApprovalResponseBody;
}) => Promise<boolean>;

export type PendingChannelControlRequest = {
  event: ChannelControlRequestEvent;
  deliveredThisProcess: boolean;
};

function getChannelApprovalScopeKey(params: {
  channel: string;
  accountId?: string;
  chatId: string;
  threadId?: string | null;
}): string {
  return [
    params.channel,
    params.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID,
    params.chatId,
    params.threadId ?? "",
  ].join(":");
}

export class ChannelControlRequests {
  private readonly pendingById = new Map<
    string,
    PendingChannelControlRequest
  >();
  private readonly requestIdByScope = new Map<string, string>();

  constructor(
    private readonly deps: {
      getAdapter: (
        channelId: string,
        accountId: string,
      ) => ChannelAdapter | null;
      getApprovalResponseHandler: () => ChannelApprovalResponseHandler | null;
    },
  ) {
    this.primePersistedRequests();
  }

  has(requestId: string): boolean {
    return this.pendingById.has(requestId);
  }

  getAll(): PendingChannelControlRequest[] {
    return Array.from(this.pendingById.values()).map((pending) => ({
      event: structuredClone(pending.event),
      deliveredThisProcess: pending.deliveredThisProcess,
    }));
  }

  private primePersistedRequests(): void {
    for (const event of listPersistedPendingControlRequests()) {
      this.pendingById.set(event.requestId, {
        event,
        deliveredThisProcess: false,
      });
      this.requestIdByScope.set(
        getChannelApprovalScopeKey({
          channel: event.source.channel,
          accountId: event.source.accountId,
          chatId: event.source.chatId,
          threadId: event.source.threadId,
        }),
        event.requestId,
      );
    }
  }

  async handleNativeResponse(
    input: ChannelControlResponseInput,
  ): Promise<ChannelControlResponseResult> {
    const pending = this.pendingById.get(input.requestId);
    if (!pending) return "expired";

    const source = pending.event.source;
    const matchesTarget =
      source.channel === input.channel &&
      (source.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID) ===
        (input.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID) &&
      source.chatId === input.chatId &&
      (source.threadId ?? null) === (input.threadId ?? null);
    if (
      !matchesTarget ||
      (source.senderId && source.senderId !== input.senderId)
    ) {
      return "forbidden";
    }

    const approvalResponseHandler = this.deps.getApprovalResponseHandler();
    if (!approvalResponseHandler) return "unavailable";
    const handled = await approvalResponseHandler({
      runtime: {
        agent_id: source.agentId,
        conversation_id: source.conversationId,
      },
      response: input.response,
    });
    this.clear(input.requestId);
    return handled ? "handled" : "expired";
  }

  private async deliver(requestId: string): Promise<boolean> {
    const pending = this.pendingById.get(requestId);
    if (!pending) return false;
    const event = pending.event;
    const adapter = this.deps.getAdapter(
      event.source.channel,
      event.source.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID,
    );
    if (!adapter) return false;

    try {
      if (adapter.handleControlRequestEvent) {
        await adapter.handleControlRequestEvent(event);
      } else {
        await adapter.sendDirectReply(
          event.source.chatId,
          formatChannelControlRequestPrompt(event),
          { replyToMessageId: event.source.threadId ?? event.source.messageId },
        );
      }
      pending.deliveredThisProcess = true;
      return true;
    } catch (error) {
      console.error(
        `[Channels] Failed to deliver control request prompt for ${event.source.channel}/${event.source.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID}:`,
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  }

  async register(event: ChannelControlRequestEvent): Promise<void> {
    const scopeKey = getChannelApprovalScopeKey({
      channel: event.source.channel,
      accountId: event.source.accountId,
      chatId: event.source.chatId,
      threadId: event.source.threadId,
    });
    const existingRequestId = this.requestIdByScope.get(scopeKey);
    if (existingRequestId) this.clear(existingRequestId);
    this.pendingById.set(event.requestId, {
      event,
      deliveredThisProcess: false,
    });
    this.requestIdByScope.set(scopeKey, event.requestId);
    upsertPersistedPendingControlRequest(event);
    await this.deliver(event.requestId);
  }

  async redeliver(requestId: string): Promise<boolean> {
    return this.deliver(requestId);
  }

  clear(requestId: string): void {
    removePersistedPendingControlRequest(requestId);
    const pending = this.pendingById.get(requestId);
    if (!pending) return;
    this.pendingById.delete(requestId);
    const scopeKey = getChannelApprovalScopeKey({
      channel: pending.event.source.channel,
      accountId: pending.event.source.accountId,
      chatId: pending.event.source.chatId,
      threadId: pending.event.source.threadId,
    });
    if (this.requestIdByScope.get(scopeKey) === requestId) {
      this.requestIdByScope.delete(scopeKey);
    }
  }

  clearAll(): void {
    this.pendingById.clear();
    this.requestIdByScope.clear();
  }

  async tryHandleInbound(
    adapter: ChannelAdapter,
    msg: InboundChannelMessage,
  ): Promise<boolean> {
    const channelCommand =
      parseChannelSlashCommand(msg.text) ??
      (msg.channel === "slack" && msg.isMention === true
        ? parseChannelBangCommand(msg.text)
        : null);
    if (channelCommand) return false;

    const scopeKey = getChannelApprovalScopeKey({
      channel: msg.channel,
      accountId: msg.accountId,
      chatId: msg.chatId,
      threadId: msg.threadId,
    });
    const requestId = this.requestIdByScope.get(scopeKey);
    if (!requestId) return false;
    const pending = this.pendingById.get(requestId);
    if (!pending) {
      this.requestIdByScope.delete(scopeKey);
      return false;
    }

    // Same ownership rule as handleNativeResponse: only the sender the
    // prompt was created for may answer it. Messages from other chat
    // participants fall through to normal ingress handling instead of
    // being consumed as an approval response.
    if (
      pending.event.source.senderId &&
      pending.event.source.senderId !== msg.senderId
    ) {
      return false;
    }

    if (
      msg.channel === "slack" &&
      pending.event.kind === "generic_tool_approval"
    ) {
      return false;
    }

    const parsed = parseChannelControlRequestResponse(pending.event, msg.text);
    if (parsed.type === "reprompt") {
      await adapter.sendDirectReply(
        msg.chatId,
        parsed.message,
        buildDirectReplyOptions(msg),
      );
      return true;
    }

    const approvalResponseHandler = this.deps.getApprovalResponseHandler();
    if (!approvalResponseHandler) {
      await adapter.sendDirectReply(
        msg.chatId,
        "I’m reconnecting to Letta Code right now, so I couldn’t use that reply yet. Please send it again in a moment.",
        buildDirectReplyOptions(msg),
      );
      return true;
    }

    const handled = await approvalResponseHandler({
      runtime: {
        agent_id: pending.event.source.agentId,
        conversation_id: pending.event.source.conversationId,
      },
      response: parsed.response,
    });
    this.clear(requestId);
    if (!handled) {
      await adapter.sendDirectReply(
        msg.chatId,
        "That approval prompt expired before I could use your reply. Please ask the agent to try again.",
        buildDirectReplyOptions(msg),
      );
    }
    return true;
  }
}
