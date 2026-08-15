import type { ExternalToolCallResult } from "@/types/app-server-protocol";
import { formatOutboundChannelMessage } from "./message-channel-formatting";
import {
  MessageChannelDuplicateActionError,
  type MessageChannelIdempotencyScope,
} from "./message-channel-idempotency";
import type {
  MessageChannelInput,
  NormalizedMessageChannelInput,
} from "./message-channel-types";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionRequest,
  ChannelMessageActionRoute,
  ChannelMessageActionTransport,
  ChannelResolvedMessageTarget,
} from "./plugin-types";
import type { ChannelTurnSource, SupportedChannelId } from "./types";

export interface MessageChannelExecutionScope {
  agentId: string;
  conversationId: string;
}

export interface ResolvedMessageChannelContext {
  route: ChannelMessageActionRoute;
  transport: ChannelMessageActionTransport;
  messageActions: ChannelMessageActionAdapter;
}

export interface ResolvedProactiveMessageChannelContext {
  accountId: string;
  target: ChannelResolvedMessageTarget;
  transport: ChannelMessageActionTransport;
  messageActions: ChannelMessageActionAdapter;
}

export interface MessageChannelExecutionResolver {
  isSupportedChannel(channel: string): boolean;
  resolveRoutedContext(params: {
    channel: SupportedChannelId;
    chatId: string;
    accountId?: string;
    scope: MessageChannelExecutionScope;
  }):
    | Promise<ResolvedMessageChannelContext | string | null>
    | ResolvedMessageChannelContext
    | string
    | null;
  resolveProactiveContext?(params: {
    channel: SupportedChannelId;
    target: string;
    accountId?: string;
    scope: MessageChannelExecutionScope;
  }):
    | Promise<ResolvedProactiveMessageChannelContext | string>
    | ResolvedProactiveMessageChannelContext
    | string;
}

export interface ExecuteMessageChannelOptions {
  scope: MessageChannelExecutionScope;
  resolver: MessageChannelExecutionResolver;
  channelTurnSources?: ChannelTurnSource[];
  idempotencyScope?: MessageChannelIdempotencyScope | null;
}

export function createMessageChannelExternalToolResult(
  text: string,
): ExternalToolCallResult {
  return {
    content: [{ type: "text", text }],
    is_error: text.startsWith("Error:"),
  };
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return undefined;
}

function firstDefinedBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function normalizeChatTarget(
  channel: SupportedChannelId,
  value: string,
): string {
  const trimmed = value.trim();
  if (channel === "signal") return trimmed;
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

function normalizeMessageChannelInput(
  input: MessageChannelInput | Record<string, unknown>,
  resolver: MessageChannelExecutionResolver,
): NormalizedMessageChannelInput | string {
  const channel = firstNonEmptyString(input.channel)?.toLowerCase();
  if (!channel) return "Error: MessageChannel requires channel.";
  if (!resolver.isSupportedChannel(channel)) {
    return `Error: Unsupported channel "${channel}".`;
  }

  const rawAction = firstNonEmptyString(input.action);
  if (!rawAction) return "Error: MessageChannel requires action.";
  const action = rawAction.trim().toLowerCase();
  if (!action) {
    return `Error: Unsupported MessageChannel action "${input.action}".`;
  }

  const rawChatId = firstNonEmptyString(input.chat_id);
  const rawTarget = firstNonEmptyString(input.target);
  if ((!rawChatId && !rawTarget) || (rawChatId && rawTarget)) {
    return "Error: MessageChannel requires exactly one of chat_id or target.";
  }

  return {
    action,
    channel,
    ...(rawChatId ? { chatId: normalizeChatTarget(channel, rawChatId) } : {}),
    ...(rawTarget ? { target: rawTarget } : {}),
    accountId: firstNonEmptyString(input.accountId),
    message: firstNonEmptyString(input.message),
    replyToMessageId: firstNonEmptyString(input.replyTo),
    threadId: firstNonEmptyString(input.threadId) ?? null,
    messageId: firstNonEmptyString(input.messageId),
    attachmentId: firstNonEmptyString(input.attachmentId),
    emoji: firstNonEmptyString(input.emoji),
    remove: firstDefinedBoolean(input.remove),
    mediaPath: firstNonEmptyString(input.media),
    filename: firstNonEmptyString(input.filename),
    title: firstNonEmptyString(input.title),
  };
}

function buildMessageChannelRequest(
  input: NormalizedMessageChannelInput,
  chatId: string,
  threadId?: string | null,
): ChannelMessageActionRequest {
  return {
    action: input.action,
    channel: input.channel,
    chatId,
    message: input.message,
    replyToMessageId: input.replyToMessageId,
    threadId: threadId ?? input.threadId ?? null,
    messageId: input.messageId,
    attachmentId: input.attachmentId,
    emoji: input.emoji,
    remove: input.remove,
    mediaPath: input.mediaPath,
    filename: input.filename,
    title: input.title,
  };
}

function inferAccountIdFromChannelTurnSources(params: {
  input: NormalizedMessageChannelInput;
  scope: MessageChannelExecutionScope;
  channelTurnSources?: ChannelTurnSource[];
}): string | undefined {
  const chatId = params.input.chatId;
  if (!chatId) return undefined;

  const accountIds = new Set<string>();
  for (const source of params.channelTurnSources ?? []) {
    if (
      source.channel !== params.input.channel ||
      source.chatId !== chatId ||
      source.agentId !== params.scope.agentId ||
      source.conversationId !== params.scope.conversationId ||
      (params.input.threadId !== null &&
        source.threadId !== params.input.threadId)
    ) {
      continue;
    }
    if (source.accountId?.trim()) accountIds.add(source.accountId.trim());
  }
  return accountIds.size === 1 ? [...accountIds][0] : undefined;
}

function inferThreadIdFromChannelTurnSources(params: {
  input: NormalizedMessageChannelInput;
  scope: MessageChannelExecutionScope;
  accountId?: string;
  channelTurnSources?: ChannelTurnSource[];
}): string | null | undefined {
  if (!params.input.chatId || params.input.threadId !== null) return undefined;

  const threadIds = new Set<string | null>();
  for (const source of params.channelTurnSources ?? []) {
    if (
      source.channel !== params.input.channel ||
      source.chatId !== params.input.chatId ||
      source.agentId !== params.scope.agentId ||
      source.conversationId !== params.scope.conversationId ||
      (params.accountId && source.accountId !== params.accountId)
    ) {
      continue;
    }
    const fallbackThreadId =
      params.input.channel === "slack" && source.chatType !== "direct"
        ? source.messageId
        : null;
    threadIds.add(source.threadId ?? fallbackThreadId ?? null);
  }
  return threadIds.size === 1 ? [...threadIds][0] : undefined;
}

function noRouteError(params: {
  input: NormalizedMessageChannelInput;
  accountId?: string;
}): string {
  return params.accountId
    ? `Error: No route for chat_id "${params.input.chatId}" on "${params.input.channel}" account "${params.accountId}" for this agent/conversation.`
    : `Error: No route for chat_id "${params.input.chatId}" on "${params.input.channel}" for this agent/conversation. If multiple channel accounts can receive this chat, pass accountId (from the channel notification's account_id) to disambiguate.`;
}

function validateResolvedRoute(
  context: ResolvedMessageChannelContext,
  scope: MessageChannelExecutionScope,
  chatId: string,
  accountId?: string,
): string | null {
  const route = context.route;
  if (
    route.chatId !== chatId ||
    route.agentId !== scope.agentId ||
    route.conversationId !== scope.conversationId ||
    (accountId !== undefined && route.accountId !== accountId)
  ) {
    return "Error: Resolved MessageChannel route is outside the current execution scope.";
  }
  return null;
}

function buildProactiveRoute(params: {
  context: ResolvedProactiveMessageChannelContext;
  scope: MessageChannelExecutionScope;
}): ChannelMessageActionRoute {
  return {
    accountId: params.context.accountId,
    chatId: params.context.target.chatId,
    chatType: params.context.target.chatType,
    threadId: params.context.target.threadId ?? null,
    agentId: params.scope.agentId,
    conversationId: params.scope.conversationId,
  };
}

async function dispatchMessageChannelAction(params: {
  request: ChannelMessageActionRequest;
  context: ResolvedMessageChannelContext;
}): Promise<string> {
  const discovery = params.context.messageActions.describeMessageTool({
    accountId: params.context.route.accountId ?? null,
  });
  const supportedActions = new Set<string>(["send"]);
  for (const action of discovery.actions ?? []) supportedActions.add(action);
  if (!supportedActions.has(params.request.action)) {
    return `Error: Action "${params.request.action}" is not supported on ${params.request.channel}.`;
  }

  return await params.context.messageActions.handleAction({
    request: params.request,
    route: params.context.route,
    adapter: params.context.transport,
    formatText: (text) =>
      formatOutboundChannelMessage(params.request.channel, text),
  });
}

function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function effectiveTextThreadId(
  request: ChannelMessageActionRequest,
  route: ChannelMessageActionRoute,
): string | null {
  const requestThreadId = trimmedOrNull(request.threadId);
  const routeThreadId = trimmedOrNull(route.threadId);

  if (request.channel === "telegram") {
    if (requestThreadId) return requestThreadId;
    if (route.chatType === "direct") return null;
    return route.chatId.trim().startsWith("-") ? routeThreadId : null;
  }
  if (request.channel === "discord") {
    return route.chatType === "direct"
      ? route.chatId
      : (requestThreadId ?? routeThreadId);
  }
  if (request.channel === "slack") {
    const isDirect =
      route.chatType === "direct" || request.chatId.startsWith("D");
    if (isDirect) return requestThreadId ?? routeThreadId;
    return request.replyToMessageId ? null : (requestThreadId ?? routeThreadId);
  }
  return null;
}

function effectiveTextReplyId(
  request: ChannelMessageActionRequest,
  route: ChannelMessageActionRoute,
): string | null {
  const isSlackDirect =
    request.channel === "slack" &&
    (route.chatType === "direct" || request.chatId.startsWith("D"));
  return isSlackDirect ? null : trimmedOrNull(request.replyToMessageId);
}

/**
 * Fingerprint only immutable text deliveries. Reactions are reversible,
 * downloads are repeatable, and a local media path can change contents during
 * a turn, so those actions intentionally bypass suppression.
 */
function messageIdempotencyKey(
  request: ChannelMessageActionRequest,
  route: ChannelMessageActionRoute,
): string | null {
  if (
    (request.action !== "send" && request.action !== "send-rich") ||
    request.mediaPath
  ) {
    return null;
  }
  return JSON.stringify({
    action: request.action,
    channel: request.channel,
    chatId: route.chatId,
    accountId: route.accountId ?? null,
    chatType: route.chatType ?? null,
    threadId: effectiveTextThreadId(request, route),
    message: request.message ?? null,
    replyToMessageId: effectiveTextReplyId(request, route),
  });
}

/**
 * Execute the canonical MessageChannel contract against host-owned routing and
 * transport adapters. This owns normalization, scope checks, thread/account
 * inference, action discovery, and outbound formatting without requiring the
 * local channel registry or local credentials.
 */
export async function executeMessageChannel(
  input: MessageChannelInput | Record<string, unknown>,
  options: ExecuteMessageChannelOptions,
): Promise<string> {
  const normalized = normalizeMessageChannelInput(input, options.resolver);
  if (typeof normalized === "string") return normalized;
  if (
    normalized.channel === "slack" &&
    normalized.action === "download-file" &&
    normalized.target
  ) {
    return "Error: Slack download-file requires chat_id from a routed channel context; target is not supported.";
  }

  try {
    if (normalized.chatId) {
      const accountId =
        normalized.accountId ??
        inferAccountIdFromChannelTurnSources({
          input: normalized,
          scope: options.scope,
          channelTurnSources: options.channelTurnSources,
        });
      const context = await options.resolver.resolveRoutedContext({
        channel: normalized.channel,
        chatId: normalized.chatId,
        accountId,
        scope: options.scope,
      });
      if (typeof context === "string") return context;
      if (!context) return noRouteError({ input: normalized, accountId });
      const routeError = validateResolvedRoute(
        context,
        options.scope,
        normalized.chatId,
        accountId,
      );
      if (routeError) return routeError;

      const inferredThreadId = inferThreadIdFromChannelTurnSources({
        input: normalized,
        scope: options.scope,
        accountId,
        channelTurnSources: options.channelTurnSources,
      });
      const requestThreadId =
        normalized.action === "download-file"
          ? normalized.threadId
          : (inferredThreadId ??
            (normalized.channel === "telegram" &&
            context.route.chatType === "direct"
              ? normalized.threadId
              : (context.route.threadId ?? normalized.threadId)));
      const request = buildMessageChannelRequest(
        normalized,
        normalized.chatId,
        requestThreadId,
      );
      return await dispatchWithIdempotency(
        request,
        context,
        options.idempotencyScope,
      );
    }

    if (normalized.channel !== "slack") {
      return `Error: Explicit MessageChannel targets are not supported on ${normalized.channel}.`;
    }
    if (!options.resolver.resolveProactiveContext) {
      return "Error: Explicit MessageChannel targets are not supported on slack.";
    }
    const proactive = await options.resolver.resolveProactiveContext({
      channel: normalized.channel,
      target: normalized.target ?? "",
      accountId: normalized.accountId,
      scope: options.scope,
    });
    if (typeof proactive === "string") return proactive;
    const context: ResolvedMessageChannelContext = {
      route: buildProactiveRoute({ context: proactive, scope: options.scope }),
      transport: proactive.transport,
      messageActions: proactive.messageActions,
    };
    const request = buildMessageChannelRequest(
      normalized,
      proactive.target.chatId,
      proactive.target.threadId,
    );
    return await dispatchWithIdempotency(
      request,
      context,
      options.idempotencyScope,
    );
  } catch (error) {
    if (error instanceof MessageChannelDuplicateActionError) throw error;
    const message = error instanceof Error ? error.message : "unknown error";
    return `Error: Sending message to ${normalized.channel} failed: ${message}`;
  }
}

/** Execute MessageChannel and return the canonical external-tool result. */
export async function executeMessageChannelExternalTool(
  input: MessageChannelInput | Record<string, unknown>,
  options: ExecuteMessageChannelOptions,
): Promise<ExternalToolCallResult> {
  return createMessageChannelExternalToolResult(
    await executeMessageChannel(input, options),
  );
}

function dispatchWithIdempotency(
  request: ChannelMessageActionRequest,
  context: ResolvedMessageChannelContext,
  scope: MessageChannelIdempotencyScope | null | undefined,
): Promise<string> {
  const dispatch = () => dispatchMessageChannelAction({ request, context });
  const key = messageIdempotencyKey(request, context.route);
  return scope ? scope.execute(key, dispatch) : dispatch();
}
