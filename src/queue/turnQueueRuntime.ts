import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";

type MessageContentParts = Exclude<MessageCreate["content"], string>;

export type QueuedTurnInput<TUserContent> =
  | {
      kind: "user";
      content: TUserContent;
    }
  | {
      kind: "task_notification";
      text: string;
    };

type MergeQueuedTurnInputOptions<TUserContent> = {
  normalizeUserContent: (content: TUserContent) => MessageCreate["content"];
  separatorText?: string;
};

function appendContentParts(
  target: MessageContentParts,
  content: MessageCreate["content"],
): void {
  if (typeof content === "string") {
    target.push({ type: "text", text: content });
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

    if (item.kind === "task_notification") {
      mergedParts.push({ type: "text", text: item.text });
      continue;
    }

    appendContentParts(mergedParts, options.normalizeUserContent(item.content));
  }

  return mergedParts.length > 0
    ? (mergedParts as MessageCreate["content"])
    : null;
}
