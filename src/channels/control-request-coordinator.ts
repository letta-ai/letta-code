import type { ApprovalResponseBody } from "@/types/protocol_v2";
import { parseChannelControlRequestResponse } from "./interactive";
import type {
  ChannelControlRequestEvent,
  ChannelControlResponseInput,
  ChannelControlResponseResult,
} from "./types";

export type PendingChannelControlRequest = {
  event: ChannelControlRequestEvent;
  deliveredThisProcess: boolean;
};

export interface ChannelControlRequestInboundInput {
  channel: string;
  accountId?: string;
  chatId: string;
  messageId?: string;
  threadId?: string | null;
  senderId: string;
  text: string;
  bypass?: boolean;
}

export type ChannelControlRequestResponseDeliveryResult =
  | "handled"
  | "expired"
  | "unavailable";

export interface ChannelControlRequestCoordinatorOptions {
  deliverPrompt(event: ChannelControlRequestEvent): Promise<void>;
  deliverReprompt(
    event: ChannelControlRequestEvent,
    input: ChannelControlRequestInboundInput,
    message: string,
  ): Promise<void>;
  deliverResponse(
    event: ChannelControlRequestEvent,
    response: ApprovalResponseBody,
  ): Promise<ChannelControlRequestResponseDeliveryResult>;
  persist(event: ChannelControlRequestEvent): Promise<void> | void;
  remove(requestId: string): Promise<void> | void;
}

function getChannelControlRequestScopeKey(params: {
  channel: string;
  accountId?: string;
  chatId: string;
  threadId?: string | null;
}): string {
  return [
    params.channel,
    params.accountId ?? "default",
    params.chatId,
    params.threadId ?? "",
  ].join(":");
}

function cloneEvent(
  event: ChannelControlRequestEvent,
): ChannelControlRequestEvent {
  return structuredClone(event);
}

export class ChannelControlRequestCoordinator {
  private readonly pendingById = new Map<
    string,
    PendingChannelControlRequest
  >();
  private readonly requestIdByScope = new Map<string, string>();

  constructor(
    private readonly options: ChannelControlRequestCoordinatorOptions,
  ) {}

  restore(events: ChannelControlRequestEvent[]): void {
    for (const event of events) {
      this.remember(event, false);
    }
  }

  has(requestId: string): boolean {
    return this.pendingById.has(requestId);
  }

  getAll(): PendingChannelControlRequest[] {
    return Array.from(this.pendingById.values()).map((pending) => ({
      event: cloneEvent(pending.event),
      deliveredThisProcess: pending.deliveredThisProcess,
    }));
  }

  async register(event: ChannelControlRequestEvent): Promise<void> {
    const scopeKey = getChannelControlRequestScopeKey(event.source);
    const existingRequestId = this.requestIdByScope.get(scopeKey);
    if (existingRequestId && existingRequestId !== event.requestId) {
      await this.clear(existingRequestId);
    }
    this.remember(event, false);
    await this.options.persist(cloneEvent(event));
    await this.deliver(event.requestId);
  }

  async redeliver(requestId: string): Promise<boolean> {
    return this.deliver(requestId);
  }

  async handleNativeResponse(
    input: ChannelControlResponseInput,
  ): Promise<ChannelControlResponseResult> {
    const pending = this.pendingById.get(input.requestId);
    if (!pending) return "expired";
    const source = pending.event.source;
    if (
      source.channel !== input.channel ||
      (source.accountId ?? "default") !== (input.accountId ?? "default") ||
      source.chatId !== input.chatId ||
      (source.threadId ?? null) !== (input.threadId ?? null) ||
      (source.senderId && source.senderId !== input.senderId)
    ) {
      return "forbidden";
    }

    const result = await this.options.deliverResponse(
      cloneEvent(pending.event),
      input.response,
    );
    if (result === "handled" || result === "expired") {
      await this.clear(input.requestId);
    }
    return result;
  }

  async tryHandleInbound(
    input: ChannelControlRequestInboundInput,
  ): Promise<boolean> {
    if (input.bypass) return false;
    const requestId = this.requestIdByScope.get(
      getChannelControlRequestScopeKey(input),
    );
    if (!requestId) return false;
    const pending = this.pendingById.get(requestId);
    if (!pending) {
      this.requestIdByScope.delete(getChannelControlRequestScopeKey(input));
      return false;
    }
    if (
      pending.event.source.senderId &&
      pending.event.source.senderId !== input.senderId
    ) {
      return false;
    }
    if (
      input.channel === "slack" &&
      pending.event.kind === "generic_tool_approval"
    ) {
      return false;
    }

    const parsed = parseChannelControlRequestResponse(
      pending.event,
      input.text,
    );
    if (parsed.type === "reprompt") {
      await this.options.deliverReprompt(
        cloneEvent(pending.event),
        input,
        parsed.message,
      );
      return true;
    }

    const result = await this.options.deliverResponse(
      cloneEvent(pending.event),
      parsed.response,
    );
    if (result === "unavailable") {
      await this.options.deliverReprompt(
        cloneEvent(pending.event),
        input,
        "I’m reconnecting to Letta Code right now, so I couldn’t use that reply yet. Please send it again in a moment.",
      );
      return true;
    }
    await this.clear(requestId);
    if (result === "expired") {
      await this.options.deliverReprompt(
        cloneEvent(pending.event),
        input,
        "That approval prompt expired before I could use your reply. Please ask the agent to try again.",
      );
    }
    return true;
  }

  async clear(requestId: string): Promise<void> {
    const pending = this.pendingById.get(requestId);
    if (pending) {
      this.pendingById.delete(requestId);
      const scopeKey = getChannelControlRequestScopeKey(pending.event.source);
      if (this.requestIdByScope.get(scopeKey) === requestId) {
        this.requestIdByScope.delete(scopeKey);
      }
    }
    await this.options.remove(requestId);
  }

  clearAll(): void {
    this.pendingById.clear();
    this.requestIdByScope.clear();
  }

  private remember(
    event: ChannelControlRequestEvent,
    deliveredThisProcess: boolean,
  ): void {
    const nextEvent = cloneEvent(event);
    this.pendingById.set(event.requestId, {
      event: nextEvent,
      deliveredThisProcess,
    });
    this.requestIdByScope.set(
      getChannelControlRequestScopeKey(event.source),
      event.requestId,
    );
  }

  private async deliver(requestId: string): Promise<boolean> {
    const pending = this.pendingById.get(requestId);
    if (!pending) return false;
    await this.options.deliverPrompt(cloneEvent(pending.event));
    pending.deliveredThisProcess = true;
    return true;
  }
}
