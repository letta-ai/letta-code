import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";

type MessageContentParts = Exclude<MessageCreate["content"], string>;

export type QueuedTurnInput<TUserContent> =
  | {
      kind: "user";
      content: TUserContent;
    }
  | {
      kind: "task_notification";
      text: string;
    }
  | {
      kind: "cron_prompt";
      text: string;
    };

/** Passive context contributed by a mod to the next turn already in flight. */
export interface ModTurnQueueItem {
  kind: "context";
  content: MessageCreate["content"];
}

type ModTurnStartInputState = {
  input: unknown;
  queueItems: ModTurnQueueItem[];
};

type MergeQueuedTurnInputOptions<TUserContent> = {
  normalizeUserContent: (content: TUserContent) => MessageCreate["content"];
  separatorText?: string;
};

function stringifyUnexpectedContent(content: unknown): string {
  try {
    return JSON.stringify(content) ?? String(content);
  } catch {
    return String(content);
  }
}

function appendContentParts(
  target: MessageContentParts,
  content: MessageCreate["content"],
): void {
  if (typeof content === "string") {
    target.push({ type: "text", text: content });
    return;
  }

  if (!Array.isArray(content)) {
    if (content === null || content === undefined) return;
    target.push({ type: "text", text: stringifyUnexpectedContent(content) });
    return;
  }

  target.push(...content);
}

export function mergeQueuedTurnInput<TUserContent>(
  queued: QueuedTurnInput<TUserContent>[],
  options: MergeQueuedTurnInputOptions<TUserContent>,
): MessageCreate["content"] | null {
  if (queued.length === 0) {
    return null;
  }

  const separatorText = options.separatorText ?? "\n";

  const mergedParts: MessageContentParts = [];
  let isFirst = true;

  for (const item of queued) {
    if (!isFirst) {
      mergedParts.push({ type: "text", text: separatorText });
    }
    isFirst = false;

    if (item.kind === "task_notification" || item.kind === "cron_prompt") {
      mergedParts.push({ type: "text", text: item.text });
      continue;
    }

    appendContentParts(mergedParts, options.normalizeUserContent(item.content));
  }

  return mergedParts.length > 0
    ? (mergedParts as MessageCreate["content"])
    : null;
}

function isApprovalCreate(
  item: MessageCreate | ApprovalCreate,
): item is ApprovalCreate {
  return item.type === "approval" || !("role" in item);
}

function isTurnInputArray(
  value: unknown,
): value is Array<MessageCreate | ApprovalCreate> {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "object" && item !== null)
  );
}

/**
 * Compose mod turn effects without giving content mods control of the approval
 * envelope. Approval continuations come from the original input and always
 * remain first. Passive mod context follows them, then ordinary turn messages.
 */
export function composeModTurnInput(options: {
  originalInput: Array<MessageCreate | ApprovalCreate>;
  transformedInput: Array<MessageCreate | ApprovalCreate>;
  queueItems: ModTurnQueueItem[];
}): Array<MessageCreate | ApprovalCreate> {
  const approvals = options.originalInput.filter(isApprovalCreate);
  const messages = options.transformedInput.filter(
    (item): item is MessageCreate => !isApprovalCreate(item),
  );
  const contextContent = mergeQueuedTurnInput(
    options.queueItems.map((item) => ({
      kind: "user" as const,
      content: item.content,
    })),
    { normalizeUserContent: (content) => content },
  );
  const contextMessages: MessageCreate[] = contextContent
    ? [{ role: "user", content: contextContent }]
    : [];

  return [...approvals, ...contextMessages, ...messages];
}

export function composeModTurnStartEventInput(
  originalInput: Array<MessageCreate | ApprovalCreate>,
  event: ModTurnStartInputState,
): Array<MessageCreate | ApprovalCreate> {
  return composeModTurnInput({
    originalInput,
    transformedInput: isTurnInputArray(event.input)
      ? event.input
      : originalInput,
    queueItems: event.queueItems,
  });
}
