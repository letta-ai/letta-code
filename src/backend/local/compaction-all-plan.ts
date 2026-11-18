import { estimateLocalMessagesTokens } from "@/backend/local/local-context-estimate";
import type { LocalMessage } from "./local-message";
import {
  addToolCallIdLookupKeys,
  assistantMessageCanContributeToolCalls,
  hasToolCallIdLookupKey,
  isLocalToolCallContent,
} from "./local-message-projection";

export interface LocalAllCompactionPlan {
  messagesToSummarize: LocalMessage[];
  messagesToKeep: LocalMessage[];
  /**
   * `messagesToKeep` is a completed tool exchange, not a pending call. It is
   * in `messagesToSummarize` too, so the summary can stand alone without it.
   */
  keepsToolExchange?: boolean;
}

export function hasPendingLocalToolCall(message: LocalMessage): boolean {
  return (
    message.role === "assistant" &&
    message.content.some((part) => part.type === "toolCall")
  );
}

/**
 * Index of the assistant message that opens the completed tool exchange the
 * conversation ends with: its tool calls (one, or several in parallel)
 * followed only by one result for each. Undefined when the conversation does
 * not end in one, including while a call still lacks its result.
 */
export function findTrailingLocalToolExchange(
  messages: readonly LocalMessage[],
): number | undefined {
  let start = messages.length;
  while (start > 0 && messages[start - 1]?.role === "toolResult") start -= 1;
  const call = messages[start - 1];
  // The provider request drops errored or aborted assistant messages, and
  // with them their results.
  if (
    start === messages.length ||
    call?.role !== "assistant" ||
    !assistantMessageCanContributeToolCalls(call)
  ) {
    return undefined;
  }
  const callIds = call.content
    .filter(isLocalToolCallContent)
    .map((part) => part.id);
  const resultIds = messages
    .slice(start)
    .flatMap((message) =>
      message.role === "toolResult" ? [message.toolCallId] : [],
    );
  // A result answers a call as removeOrphanLocalToolResults pairs them, which
  // also matches the part of an id before a `|`.
  const callKeys = new Set<string>();
  for (const id of callIds) addToolCallIdLookupKeys(callKeys, id);
  const resultKeys = new Set<string>();
  for (const id of resultIds) addToolCallIdLookupKeys(resultKeys, id);
  const complete =
    callIds.length === resultIds.length &&
    resultIds.every((id) => hasToolCallIdLookupKey(callKeys, id)) &&
    callIds.every((id) => hasToolCallIdLookupKey(resultKeys, id));
  return complete ? start - 1 : undefined;
}

/**
 * A trailing pending tool call is always kept after the summary. Given a
 * `toolExchangeBudget`, a trailing completed tool exchange whose estimate fits
 * it is kept too, so the agent sees the results it asked for. The exchange is
 * still summarised with everything else: the summary request is the agent's
 * whole context, a continuation of the conversation, whether or not the
 * exchange is kept. An incomplete exchange, one over the budget, or one with
 * nothing before it is only summarised.
 */
export function planLocalAllCompaction(
  messages: LocalMessage[],
  options: { toolExchangeBudget?: number } = {},
): LocalAllCompactionPlan {
  const lastMessage = messages.at(-1);
  if (lastMessage && hasPendingLocalToolCall(lastMessage)) {
    return {
      messagesToSummarize: messages.slice(0, -1),
      messagesToKeep: [lastMessage],
    };
  }

  const budget = options.toolExchangeBudget;
  if (budget !== undefined) {
    const start = findTrailingLocalToolExchange(messages);
    if (start && estimateLocalMessagesTokens(messages.slice(start)) <= budget) {
      return {
        messagesToSummarize: messages,
        messagesToKeep: messages.slice(start),
        keepsToolExchange: true,
      };
    }
  }

  return {
    messagesToSummarize: messages,
    messagesToKeep: [],
  };
}
