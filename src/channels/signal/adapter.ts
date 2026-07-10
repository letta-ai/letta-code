import type {
  ChannelAdapter,
  ChannelAdapterStartOptions,
  ChannelTurnLifecycleEvent,
  ChannelTurnSource,
  InboundChannelMessage,
  OutboundChannelMessage,
  SignalChannelAccount,
} from "@/channels/types";
import type { SignalReactionParams } from "./client";
import { SignalRestClient } from "./client";
import {
  formatSignalAdapterError,
  getSignalTypingKey,
  parseReactionTargetMessageId,
  signalInboundFromSseEvent,
  signalTargetMatchesAccount,
} from "./inbound";
import type {
  SignalAdapterOptions,
  SignalClientLike,
  SignalTypingEntry,
} from "./internal-types";
import { transcribeSignalInboundAttachments } from "./media";
import { parseSignalTarget } from "./target";

const SIGNAL_TYPING_REFRESH_MS = 10_000;
const SIGNAL_TYPING_TIMEOUT_MS = 5 * 60 * 1000;

export class SignalChannelAdapter implements ChannelAdapter {
  readonly id = "signal";
  readonly channelId = "signal";
  readonly accountId: string;
  readonly name = "Signal";

  onMessage?: (msg: InboundChannelMessage) => Promise<void>;

  private running = false;
  private abortController: AbortController | null = null;
  private eventLoop: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryResolve: (() => void) | null = null;
  private readonly typingByChatId = new Map<string, SignalTypingEntry>();
  private readonly client: SignalClientLike;
  private readonly retryMs: number;
  private logger?: ChannelAdapterStartOptions["logger"];

  constructor(
    private readonly account: SignalChannelAccount,
    options: SignalAdapterOptions = {},
  ) {
    this.accountId = account.accountId;
    this.client =
      options.client ??
      new SignalRestClient({
        baseUrl: account.baseUrl,
        account: account.account,
      });
    this.retryMs = options.retryMs ?? 5_000;
  }

  async start(options?: ChannelAdapterStartOptions): Promise<void> {
    if (this.running) {
      return;
    }
    await this.client.check();
    this.running = true;
    this.abortController = new AbortController();
    this.logger = options?.logger;
    this.logger?.(
      `[Signal] listening for ${this.account.account ?? this.account.accountId}`,
    );
    this.eventLoop = this.runEventLoop();
  }

  async stop(): Promise<void> {
    if (!this.running && !this.eventLoop) {
      return;
    }
    this.running = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryResolve?.();
    this.retryResolve = null;
    await this.stopAllTyping();
    this.abortController?.abort();
    await this.eventLoop?.catch(() => undefined);
    this.clearAllTyping();
    this.eventLoop = null;
    this.abortController = null;
    this.logger = undefined;
  }

  isRunning(): boolean {
    return this.running;
  }

  async sendMessage(
    msg: OutboundChannelMessage,
  ): Promise<{ messageId: string }> {
    const target = parseSignalTarget(msg.chatId);
    if (
      this.account.selfChatMode === true &&
      !signalTargetMatchesAccount(target, this.account)
    ) {
      throw new Error(
        "Signal self-chat mode only permits replies to the linked account's own Note to Self chat.",
      );
    }
    if (msg.reaction || msg.targetMessageId) {
      if (!msg.reaction) {
        throw new Error("Signal reaction emoji is required.");
      }
      if (!msg.targetMessageId) {
        throw new Error("Signal reactions require messageId.");
      }
      const parsed = parseReactionTargetMessageId(msg.targetMessageId);
      const targetAuthor =
        parsed.targetAuthor ?? this.resolveDirectTargetAuthor(msg.chatId);
      if (!targetAuthor) {
        throw new Error(
          "Signal group reactions require the messageId from an inbound Signal message so targetAuthor is known.",
        );
      }
      const reactionParams: SignalReactionParams = {
        target,
        emoji: msg.reaction,
        targetTimestamp: parsed.targetTimestamp,
        targetAuthor,
        remove: msg.removeReaction === true,
      };
      await this.client.sendReaction(reactionParams);
      await this.stopTypingForChat(msg.chatId);
      return { messageId: msg.targetMessageId };
    }

    const attachments = msg.mediaPath ? [msg.mediaPath] : undefined;
    const messageId = await this.client.sendMessage({
      target,
      message: msg.text,
      attachments,
      textStyle: msg.textStyle,
    });
    await this.stopTypingForChat(msg.chatId);
    return { messageId };
  }

  async sendDirectReply(
    chatId: string,
    text: string,
    _options?: { replyToMessageId?: string },
  ): Promise<void> {
    await this.sendMessage({
      channel: "signal",
      accountId: this.accountId,
      chatId,
      text,
    });
  }

  async prepareInboundMessage(
    msg: InboundChannelMessage,
  ): Promise<InboundChannelMessage> {
    if (msg.channel !== "signal") {
      return msg;
    }
    return transcribeSignalInboundAttachments(this.account, msg);
  }

  async handleTurnLifecycleEvent(
    event: ChannelTurnLifecycleEvent,
  ): Promise<void> {
    if (!this.running) {
      return;
    }
    if (event.type === "queued") {
      return;
    }
    if (event.type === "processing") {
      for (const source of event.sources) {
        await this.startTypingForSource(source);
      }
      return;
    }
    for (const source of event.sources) {
      await this.stopTypingForSource(source);
    }
  }

  private async startTypingForSource(source: ChannelTurnSource): Promise<void> {
    const key = getSignalTypingKey(source);
    if (!key) {
      return;
    }
    await this.stopTypingForChat(key, { sendStop: false });
    const sendTyping = async (): Promise<boolean> => {
      try {
        await this.client.sendTyping({
          target: parseSignalTarget(source.chatId),
        });
        return true;
      } catch (error) {
        console.warn(
          `[Signal] Failed to send typing indicator for ${source.chatId}:`,
          error instanceof Error ? error.message : error,
        );
        return false;
      }
    };
    if (!(await sendTyping())) {
      return;
    }
    const timer = setInterval(() => {
      void sendTyping().then((ok) => {
        if (!ok) {
          void this.stopTypingForChat(key, { sendStop: false });
        }
      });
    }, SIGNAL_TYPING_REFRESH_MS);
    const timeout = setTimeout(() => {
      void this.stopTypingForChat(key);
    }, SIGNAL_TYPING_TIMEOUT_MS);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref?: () => void }).unref?.();
    }
    if (typeof (timeout as { unref?: () => void }).unref === "function") {
      (timeout as { unref?: () => void }).unref?.();
    }
    this.typingByChatId.set(key, {
      source,
      timer,
      timeout,
    });
  }

  private async stopTypingForSource(source: ChannelTurnSource): Promise<void> {
    const key = getSignalTypingKey(source);
    if (!key) {
      return;
    }
    await this.stopTypingForChat(key);
  }

  private async stopTypingForChat(
    chatId: string,
    options: { sendStop?: boolean } = {},
  ): Promise<void> {
    const directEntry = this.typingByChatId.get(chatId);
    const key = directEntry
      ? chatId
      : Array.from(this.typingByChatId.entries()).find(
          ([, entry]) => entry.source.chatId === chatId,
        )?.[0];
    if (!key) {
      return;
    }
    const entry = this.typingByChatId.get(key);
    if (!entry) {
      return;
    }
    clearInterval(entry.timer);
    clearTimeout(entry.timeout);
    this.typingByChatId.delete(key);
    if (options.sendStop === false) {
      return;
    }
    try {
      await this.client.sendTyping({
        target: parseSignalTarget(entry.source.chatId),
        stop: true,
      });
    } catch (error) {
      console.warn(
        `[Signal] Failed to stop typing indicator for ${entry.source.chatId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  private clearAllTyping(): void {
    for (const entry of this.typingByChatId.values()) {
      clearInterval(entry.timer);
      clearTimeout(entry.timeout);
    }
    this.typingByChatId.clear();
  }

  private async stopAllTyping(): Promise<void> {
    await Promise.all(
      Array.from(this.typingByChatId.keys()).map((key) =>
        this.stopTypingForChat(key),
      ),
    );
  }

  private resolveDirectTargetAuthor(chatId: string): string | undefined {
    const target = parseSignalTarget(chatId);
    return target.kind === "recipient" ? target.recipient : undefined;
  }

  private async runEventLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.client.streamEvents(async (event) => {
          try {
            const msg = signalInboundFromSseEvent(event, this.account);
            if (!msg) {
              this.logger?.(
                `[Signal] ignored event account=${this.accountId} event=${event.event ?? "message"} id=${event.id ?? "<none>"}`,
              );
              return;
            }
            this.logger?.(
              `[Signal] inbound account=${this.accountId} chat=${msg.chatId} sender=${msg.senderId} type=${msg.chatType} chars=${msg.text.length} attachments=${msg.attachments?.length ?? 0}`,
            );
            await this.onMessage?.(msg);
          } catch (error) {
            console.error(
              `[Signal] failed to handle inbound event for ${this.accountId}:`,
              formatSignalAdapterError(error),
            );
            this.logger?.(
              `[Signal] failed inbound account=${this.accountId} event=${event.event ?? "message"} id=${event.id ?? "<none>"}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }, this.abortController?.signal);
      } catch (error) {
        if (!this.running) {
          return;
        }
        console.error(
          `[Signal] event stream failed for ${this.accountId}:`,
          formatSignalAdapterError(error),
        );
        this.logger?.(
          `[Signal] event stream failed account=${this.accountId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (this.running) {
        await new Promise<void>((resolve) => {
          this.retryResolve = resolve;
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.retryResolve = null;
            resolve();
          }, this.retryMs);
        });
      }
    }
  }
}

export function createSignalAdapter(
  account: SignalChannelAccount,
  options?: SignalAdapterOptions,
): SignalChannelAdapter {
  return new SignalChannelAdapter(account, options);
}
