import type { ApprovalResponseBody } from "@/types/protocol_v2";
import { LEGACY_CHANNEL_ACCOUNT_ID } from "./accounts";
import { parseChannelBangCommand, parseChannelSlashCommand } from "./commands";
import {
  ChannelControlRequestCoordinator,
  type PendingChannelControlRequest,
} from "./control-request-coordinator";
import { formatChannelControlRequestPrompt } from "./interactive";
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

export type { PendingChannelControlRequest };

export class ChannelControlRequests {
  private readonly coordinator: ChannelControlRequestCoordinator;

  constructor(
    private readonly deps: {
      getAdapter: (
        channelId: string,
        accountId: string,
      ) => ChannelAdapter | null;
      getApprovalResponseHandler: () => ChannelApprovalResponseHandler | null;
    },
  ) {
    this.coordinator = new ChannelControlRequestCoordinator({
      deliverPrompt: async (event) => {
        const adapter = this.getAdapter(event);
        if (!adapter) throw new Error("Channel adapter is unavailable");
        if (adapter.handleControlRequestEvent) {
          await adapter.handleControlRequestEvent(event);
          return;
        }
        await adapter.sendDirectReply(
          event.source.chatId,
          formatChannelControlRequestPrompt(event),
          { replyToMessageId: event.source.threadId ?? event.source.messageId },
        );
      },
      deliverReprompt: async (_event, input, message) => {
        const adapter = this.deps.getAdapter(
          input.channel,
          input.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID,
        );
        if (!adapter) return;
        await adapter.sendDirectReply(
          input.chatId,
          message,
          buildDirectReplyOptions(input),
        );
      },
      deliverResponse: async (event, response) => {
        const handler = this.deps.getApprovalResponseHandler();
        if (!handler) return "unavailable";
        const handled = await handler({
          runtime: {
            agent_id: event.source.agentId,
            conversation_id: event.source.conversationId,
          },
          response,
        });
        return handled ? "handled" : "expired";
      },
      persist: (event) => {
        upsertPersistedPendingControlRequest(event);
      },
      remove: (requestId) => {
        removePersistedPendingControlRequest(requestId);
      },
    });
    this.coordinator.restore(listPersistedPendingControlRequests());
  }

  has(requestId: string): boolean {
    return this.coordinator.has(requestId);
  }

  getAll(): PendingChannelControlRequest[] {
    return this.coordinator.getAll();
  }

  async handleNativeResponse(
    input: ChannelControlResponseInput,
  ): Promise<ChannelControlResponseResult> {
    return this.coordinator.handleNativeResponse(input);
  }

  async register(event: ChannelControlRequestEvent): Promise<void> {
    try {
      await this.coordinator.register(event);
    } catch (error) {
      console.error(
        `[Channels] Failed to deliver control request prompt for ${event.source.channel}/${event.source.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  async redeliver(requestId: string): Promise<boolean> {
    try {
      return await this.coordinator.redeliver(requestId);
    } catch (error) {
      const pending = this.coordinator
        .getAll()
        .find((candidate) => candidate.event.requestId === requestId);
      console.error(
        `[Channels] Failed to deliver control request prompt for ${pending?.event.source.channel ?? "unknown"}/${pending?.event.source.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID}:`,
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  }

  clear(requestId: string): void {
    void this.coordinator.clear(requestId);
  }

  clearAll(): void {
    this.coordinator.clearAll();
  }

  async tryHandleInbound(
    _adapter: ChannelAdapter,
    msg: InboundChannelMessage,
  ): Promise<boolean> {
    const channelCommand =
      parseChannelSlashCommand(msg.text) ??
      (msg.channel === "slack" && msg.isMention === true
        ? parseChannelBangCommand(msg.text)
        : null);
    return this.coordinator.tryHandleInbound({
      channel: msg.channel,
      accountId: msg.accountId,
      chatId: msg.chatId,
      messageId: msg.messageId,
      threadId: msg.threadId,
      senderId: msg.senderId,
      text: msg.text,
      bypass: Boolean(channelCommand),
    });
  }

  private getAdapter(event: ChannelControlRequestEvent): ChannelAdapter | null {
    return this.deps.getAdapter(
      event.source.channel,
      event.source.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID,
    );
  }
}
