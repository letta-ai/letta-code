import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { getChannelAccount } from "@/channels/accounts";
import { getChannelRegistry } from "@/channels/registry";
import { channelTurnSourceIdentity } from "@/channels/turn-source";
import type { ChannelAdapter, ChannelTurnSource } from "@/channels/types";
import { getRichDraftStreamingPolicy } from "@/channels/types";
import { debugLog, debugWarn } from "@/utils/debug";

const MESSAGE_CHANNEL_TOOL_NAMES = new Set([
  "MessageChannel",
  "message_channel",
]);
const DEFAULT_DRAFT_DEBOUNCE_MS = 1000;
const MIN_DRAFT_TEXT_LENGTH = 1;

type ChannelDraftSource = ChannelTurnSource & {
  accountId: string;
};

type ToolCallFragment = {
  toolCallId: string;
  name?: string;
  argumentsDelta?: string;
};

type DraftIntent = {
  chatId: string;
  accountId: string;
  threadId: string | null;
  message: string;
};

type DraftCallState = {
  toolCallId: string;
  name?: string;
  argumentsText: string;
  draftId: number;
  pendingMessage?: string;
  lastSentMessage?: string;
  finished: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void> | null;
};

type UnknownRecord = Record<string, unknown>;

export type ChannelRichDraftStreamer = {
  handleChunk(chunk: LettaStreamingResponse): void;
  flushPending(): Promise<void>;
  dispose(): void;
};

export function createChannelRichDraftStreamer(options: {
  batchId: string;
  sources?: ChannelTurnSource[];
  debounceMs?: number;
}): ChannelRichDraftStreamer | null {
  const source = resolveSingleChannelDraftSource(options.sources ?? []);
  if (!source) {
    debugLog(
      "channels",
      "Channel rich draft streamer disabled: no single channel source",
    );
    return null;
  }

  const account = getChannelAccount(source.channel, source.accountId);
  const policy = getRichDraftStreamingPolicy(account);
  if (!policy) {
    debugLog(
      "channels",
      "Channel rich draft streamer disabled: account not opted in (%s:%s)",
      source.channel,
      source.accountId,
    );
    return null;
  }

  const adapter = getChannelRegistry()?.getAdapter(
    source.channel,
    source.accountId,
  );
  if (!adapter?.sendRichMessageDraft || !adapter.isRunning()) {
    debugLog(
      "channels",
      "Channel rich draft streamer disabled: adapter unavailable (%s:%s)",
      source.channel,
      source.accountId,
    );
    return null;
  }

  debugLog(
    "channels",
    "Channel rich draft streamer enabled for channel=%s account=%s chat=%s thread=%s",
    source.channel,
    source.accountId,
    source.chatId,
    source.threadId ?? "",
  );

  return new ChannelRichDraftStreamerImpl({
    adapter,
    batchId: options.batchId,
    source,
    richPrivateChatDefault: policy.richPrivateChatDefault,
    debounceMs: options.debounceMs ?? DEFAULT_DRAFT_DEBOUNCE_MS,
  });
}

function resolveSingleChannelDraftSource(
  sources: ChannelTurnSource[],
): ChannelDraftSource | null {
  const candidateSources = sources.filter(
    (source): source is ChannelDraftSource =>
      typeof source.accountId === "string" &&
      source.accountId.trim().length > 0 &&
      getRichDraftStreamingPolicy(
        getChannelAccount(source.channel, source.accountId.trim()),
      ) !== null,
  );
  if (candidateSources.length === 0) {
    return null;
  }

  const distinctSources = new Map<string, ChannelDraftSource>();
  for (const source of candidateSources) {
    const normalizedSource = {
      ...source,
      accountId: source.accountId.trim(),
    };
    distinctSources.set(
      channelTurnSourceIdentity(normalizedSource),
      normalizedSource,
    );
    if (distinctSources.size > 1) {
      return null;
    }
  }

  return distinctSources.values().next().value ?? null;
}

class ChannelRichDraftStreamerImpl implements ChannelRichDraftStreamer {
  private readonly adapter: ChannelAdapter;
  private readonly batchId: string;
  private readonly source: ChannelDraftSource;
  private readonly richPrivateChatDefault: boolean;
  private readonly debounceMs: number;
  private readonly calls = new Map<string, DraftCallState>();
  private readonly finishedCallIds = new Set<string>();
  private lastDraftAttemptAtMs = 0;
  private retryBlockedUntilMs = 0;
  private disposed = false;

  constructor(options: {
    adapter: ChannelAdapter;
    batchId: string;
    source: ChannelDraftSource;
    richPrivateChatDefault: boolean;
    debounceMs: number;
  }) {
    this.adapter = options.adapter;
    this.batchId = options.batchId;
    this.source = options.source;
    this.richPrivateChatDefault = options.richPrivateChatDefault;
    this.debounceMs = Math.max(0, Math.trunc(options.debounceMs));
  }

  handleChunk(chunk: LettaStreamingResponse): void {
    if (this.disposed) {
      return;
    }

    const record = asRecord(chunk);
    const messageType = stringValue(record?.message_type);

    if (messageType === "tool_return_message") {
      const toolCallId = stringValue(record?.tool_call_id);
      if (toolCallId) {
        this.finishCall(toolCallId);
      }
      return;
    }

    if (
      messageType !== "approval_request_message" &&
      messageType !== "tool_call_message"
    ) {
      return;
    }

    for (const fragment of extractToolCallFragments(record)) {
      if (this.finishedCallIds.has(fragment.toolCallId)) {
        continue;
      }
      const state = this.getOrCreateCall(fragment.toolCallId);
      if (fragment.name) {
        state.name = fragment.name;
      }
      if (fragment.argumentsDelta) {
        state.argumentsText += fragment.argumentsDelta;
      }

      if (state.name && MESSAGE_CHANNEL_TOOL_NAMES.has(state.name)) {
        debugLog(
          "channels",
          "Channel rich draft streamer saw MessageChannel args: call=%s bytes=%d",
          state.toolCallId,
          state.argumentsText.length,
        );
      }

      this.maybeScheduleDraft(state);
    }
  }

  async flushPending(): Promise<void> {
    const flushes: Promise<void>[] = [];
    for (const state of this.calls.values()) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      if (
        state.pendingMessage &&
        state.pendingMessage !== state.lastSentMessage
      ) {
        flushes.push(this.sendDraft(state, { force: true }));
      } else if (state.inFlight) {
        flushes.push(state.inFlight);
      }
    }
    await Promise.allSettled(flushes);
  }

  dispose(): void {
    this.disposed = true;
    for (const state of this.calls.values()) {
      state.finished = true;
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    }
    this.calls.clear();
    this.finishedCallIds.clear();
  }

  private getOrCreateCall(toolCallId: string): DraftCallState {
    const existing = this.calls.get(toolCallId);
    if (existing) {
      return existing;
    }
    const state: DraftCallState = {
      toolCallId,
      argumentsText: "",
      draftId: buildDraftId(`${this.batchId}:${toolCallId}`),
      finished: false,
      timer: null,
      inFlight: null,
    };
    this.calls.set(toolCallId, state);
    return state;
  }

  private finishCall(toolCallId: string): void {
    this.finishedCallIds.add(toolCallId);
    const state = this.calls.get(toolCallId);
    if (!state) {
      return;
    }
    state.finished = true;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (!state.inFlight) {
      this.calls.delete(toolCallId);
    }
  }

  private maybeScheduleDraft(state: DraftCallState): void {
    if (!state.name || !MESSAGE_CHANNEL_TOOL_NAMES.has(state.name)) {
      return;
    }

    const intent = extractChannelSendRichDraftIntent(
      state.argumentsText,
      this.source,
      { richPrivateChatDefault: this.richPrivateChatDefault },
    );
    if (!intent) {
      debugLog(
        "channels",
        "Channel rich draft streamer waiting for routable intent: call=%s bytes=%d",
        state.toolCallId,
        state.argumentsText.length,
      );
      return;
    }

    const message = intent.message.trimEnd();
    if (
      message.trim().length < MIN_DRAFT_TEXT_LENGTH ||
      message === state.pendingMessage ||
      message === state.lastSentMessage
    ) {
      debugLog(
        "channels",
        "Channel rich draft streamer skipped unchanged/empty draft: call=%s chars=%d",
        state.toolCallId,
        message.length,
      );
      return;
    }

    state.pendingMessage = message;
    this.scheduleDraft(state);
  }

  private sendDraft(
    state: DraftCallState,
    options: { force?: boolean } = {},
  ): Promise<void> {
    if (state.finished) {
      return state.inFlight ?? Promise.resolve();
    }
    if (state.inFlight) {
      this.scheduleDraft(state);
      return state.inFlight;
    }

    const delayMs = this.msUntilNextDraftAttempt({ force: options.force });
    if (delayMs > 0) {
      this.setDraftTimer(state, delayMs);
      return Promise.resolve();
    }

    const message = state.pendingMessage;
    if (!message || message === state.lastSentMessage) {
      return state.inFlight ?? Promise.resolve();
    }

    this.lastDraftAttemptAtMs = Date.now();
    debugLog(
      "channels",
      "Channel rich draft streamer sending draft: call=%s draft=%d chars=%d",
      state.toolCallId,
      state.draftId,
      message.length,
    );
    const draft = {
      channel: this.source.channel,
      accountId: this.source.accountId,
      chatId: this.source.chatId,
      threadId: this.source.threadId ?? null,
      draftId: state.draftId,
      source: this.source,
      richMessage: { markdown: message },
    };

    let inFlight: Promise<void> = Promise.resolve();
    inFlight = (async () => {
      try {
        await this.adapter.sendRichMessageDraft?.(draft);
        if (!state.finished && this.calls.get(state.toolCallId) === state) {
          state.lastSentMessage = message;
        }
      } catch (error) {
        const retryAfterMs = extractRetryAfterMs(error);
        if (retryAfterMs !== null) {
          this.retryBlockedUntilMs = Math.max(
            this.retryBlockedUntilMs,
            Date.now() + retryAfterMs,
          );
        } else if (
          !state.finished &&
          this.calls.get(state.toolCallId) === state
        ) {
          state.lastSentMessage = message;
        }
        debugWarn(
          "channels",
          `[${this.source.channel}] Rich draft update failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        if (retryAfterMs !== null) {
          debugWarn(
            "channels",
            `[${this.source.channel}] Rich draft update rate-limited; retrying after ${retryAfterMs}ms`,
          );
        }
        return;
      } finally {
        if (state.inFlight === inFlight) {
          state.inFlight = null;
        }
        if (state.finished) {
          this.calls.delete(state.toolCallId);
        } else if (
          !this.disposed &&
          this.calls.get(state.toolCallId) === state &&
          state.pendingMessage &&
          state.pendingMessage !== state.lastSentMessage
        ) {
          this.scheduleDraft(state);
        }
      }
    })();
    state.inFlight = inFlight;
    return inFlight;
  }

  private scheduleDraft(state: DraftCallState): void {
    if (
      this.disposed ||
      state.finished ||
      this.calls.get(state.toolCallId) !== state
    ) {
      return;
    }
    if (
      !state.pendingMessage ||
      state.pendingMessage === state.lastSentMessage
    ) {
      return;
    }
    if (state.inFlight) {
      return;
    }

    const delayMs = this.msUntilNextDraftAttempt();
    if (delayMs <= 0) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      void this.sendDraft(state);
      return;
    }

    if (state.timer) {
      return;
    }
    this.setDraftTimer(state, delayMs);
  }

  private setDraftTimer(state: DraftCallState, delayMs: number): void {
    if (state.timer) {
      clearTimeout(state.timer);
    }
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.sendDraft(state);
    }, delayMs);
  }

  private msUntilNextDraftAttempt(options: { force?: boolean } = {}): number {
    const now = Date.now();
    const retryDelayMs = Math.max(0, this.retryBlockedUntilMs - now);
    if (this.debounceMs === 0 || options.force) {
      return retryDelayMs;
    }
    const rateLimitDelayMs = Math.max(
      0,
      this.lastDraftAttemptAtMs + this.debounceMs - now,
    );
    return Math.max(retryDelayMs, rateLimitDelayMs);
  }
}

/**
 * Best-effort extraction of a rate-limit retry hint from adapter send errors.
 * Understands common bot-API shapes (`parameters.retry_after` seconds nested
 * under response/payload/error) plus a `retry_after`-style message fallback.
 */
function extractRetryAfterMs(error: unknown): number | null {
  const candidates = findRetryAfterCandidates(error);
  for (const candidate of candidates) {
    const seconds = Number(candidate);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.ceil(seconds * 1000);
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  const retryMatch = message.match(/retry[_ -]?after\D+(\d+(?:\.\d+)?)/i);
  if (retryMatch?.[1]) {
    return Math.ceil(Number(retryMatch[1]) * 1000);
  }
  return null;
}

function findRetryAfterCandidates(error: unknown): unknown[] {
  const record = asRecord(error);
  if (!record) {
    return [];
  }
  return [
    asRecord(record.parameters)?.retry_after,
    asRecord(record.response)?.parameters &&
      asRecord(asRecord(record.response)?.parameters)?.retry_after,
    asRecord(record.payload)?.parameters &&
      asRecord(asRecord(record.payload)?.parameters)?.retry_after,
    asRecord(record.error)?.parameters &&
      asRecord(asRecord(record.error)?.parameters)?.retry_after,
  ];
}

export function extractChannelSendRichDraftIntent(
  argumentsText: string,
  source: ChannelTurnSource & { accountId: string },
  options: { richPrivateChatDefault?: boolean } = {},
): DraftIntent | null {
  const action = extractStringField(argumentsText, "action", false)?.value;
  const normalizedAction = action?.trim().toLowerCase();
  const isExplicitRichSend = normalizedAction === "send-rich";
  const isDefaultRichPrivateSend =
    normalizedAction === "send" &&
    source.chatType === "direct" &&
    options.richPrivateChatDefault !== false;
  if (!isExplicitRichSend && !isDefaultRichPrivateSend) {
    debugLog(
      "channels",
      "Channel rich draft intent rejected: action=%s",
      action ?? "",
    );
    return null;
  }

  const channel = extractStringField(argumentsText, "channel", false)?.value;
  if (channel?.trim().toLowerCase() !== source.channel) {
    debugLog(
      "channels",
      "Channel rich draft intent rejected: channel=%s source=%s",
      channel ?? "",
      source.channel,
    );
    return null;
  }

  const rawChatId = extractStringField(argumentsText, "chat_id", false)?.value;
  const chatId = rawChatId ? normalizeChatTarget(rawChatId) : null;
  if (!chatId || chatId !== source.chatId) {
    debugLog(
      "channels",
      "Channel rich draft intent rejected: chat=%s source=%s",
      chatId ?? "",
      source.chatId,
    );
    return null;
  }

  const target = extractStringField(argumentsText, "target", false)?.value;
  if (target?.trim()) {
    debugLog("channels", "Channel rich draft intent rejected: target present");
    return null;
  }

  const accountId = extractStringField(
    argumentsText,
    "accountId",
    false,
  )?.value;
  if (accountId?.trim() && accountId.trim() !== source.accountId) {
    debugLog(
      "channels",
      "Channel rich draft intent rejected: account=%s source=%s",
      accountId.trim(),
      source.accountId,
    );
    return null;
  }

  const threadIdField = extractStringField(argumentsText, "threadId", false);
  const requestedThreadId = threadIdField?.value.trim() || null;
  const sourceThreadId = source.threadId ?? null;
  if (requestedThreadId !== null && requestedThreadId !== sourceThreadId) {
    debugLog(
      "channels",
      "Channel rich draft intent rejected: thread=%s source=%s",
      requestedThreadId,
      sourceThreadId ?? "",
    );
    return null;
  }

  const media = extractStringField(argumentsText, "media", false)?.value;
  if (media?.trim()) {
    debugLog("channels", "Channel rich draft intent rejected: media present");
    return null;
  }

  const message = extractStringField(argumentsText, "message", true)?.value;
  if (!message?.trim()) {
    debugLog("channels", "Channel rich draft intent rejected: message missing");
    return null;
  }

  return {
    accountId: source.accountId,
    chatId,
    threadId: sourceThreadId,
    message,
  };
}

function extractToolCallFragments(
  record: UnknownRecord | null,
): ToolCallFragment[] {
  if (!record) {
    return [];
  }
  const rawToolCalls = Array.isArray(record.tool_calls)
    ? record.tool_calls
    : record.tool_call
      ? [record.tool_call]
      : [];

  const fragments: ToolCallFragment[] = [];
  for (const rawToolCall of rawToolCalls) {
    const toolCall = asRecord(rawToolCall);
    const toolCallId = stringValue(toolCall?.tool_call_id);
    if (!toolCallId) {
      continue;
    }
    fragments.push({
      toolCallId,
      name: stringValue(toolCall?.name),
      argumentsDelta: stringValue(toolCall?.arguments),
    });
  }
  return fragments;
}

function extractStringField(
  input: string,
  field: string,
  allowPartialValue: boolean,
): { value: string; complete: boolean } | null {
  let index = 0;
  while (index < input.length) {
    const quoteIndex = input.indexOf('"', index);
    if (quoteIndex === -1) {
      return null;
    }

    const key = readJsonStringAt(input, quoteIndex, false);
    if (!key) {
      return null;
    }

    index = key.end;
    let cursor = skipWhitespace(input, key.end);
    if (input[cursor] !== ":") {
      continue;
    }
    cursor = skipWhitespace(input, cursor + 1);
    if (key.value !== field) {
      index = cursor;
      continue;
    }
    if (input[cursor] !== '"') {
      return null;
    }
    return readJsonStringAt(input, cursor, allowPartialValue);
  }
  return null;
}

function readJsonStringAt(
  input: string,
  quoteIndex: number,
  allowPartial: boolean,
): { value: string; end: number; complete: boolean } | null {
  if (input[quoteIndex] !== '"') {
    return null;
  }

  let raw = "";
  let cursor = quoteIndex + 1;
  while (cursor < input.length) {
    const char = input[cursor];
    if (char === "\\") {
      if (cursor + 1 >= input.length) {
        return allowPartial
          ? {
              value: decodeJsonStringFragment(raw, false),
              end: input.length,
              complete: false,
            }
          : null;
      }
      raw += input.slice(cursor, cursor + 2);
      cursor += 2;
      continue;
    }
    if (char === '"') {
      return {
        value: decodeJsonStringFragment(raw, true),
        end: cursor + 1,
        complete: true,
      };
    }
    raw += char;
    cursor += 1;
  }

  return allowPartial
    ? {
        value: decodeJsonStringFragment(raw, false),
        end: input.length,
        complete: false,
      }
    : null;
}

function decodeJsonStringFragment(raw: string, complete: boolean): string {
  let candidate = raw;
  if (!complete) {
    candidate = candidate.replace(/\\u[0-9a-fA-F]{0,3}$/, "");
    if (candidate.endsWith("\\")) {
      candidate = candidate.slice(0, -1);
    }
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return JSON.parse(`"${candidate}"`) as string;
    } catch {
      if (candidate.length === 0) {
        break;
      }
      candidate = candidate.slice(0, -1);
    }
  }

  return candidate
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function skipWhitespace(input: string, index: number): number {
  let cursor = index;
  while (cursor < input.length && /\s/.test(input[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor;
}

function normalizeChatTarget(value: string): string {
  const trimmed = value.trim();
  const parts = trimmed
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 2 && /^[a-z_-]+$/i.test(parts[0] ?? "")) {
    return parts[1] ?? trimmed;
  }
  if (
    parts.length === 3 &&
    /^[a-z_-]+$/i.test(parts[0] ?? "") &&
    /^[a-z_-]+$/i.test(parts[1] ?? "")
  ) {
    return parts[2] ?? trimmed;
  }
  return trimmed;
}

function buildDraftId(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  const positive = hash >>> 1;
  return positive === 0 ? 1 : positive;
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" ? (value as UnknownRecord) : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
