import type { SimpleStreamOptions } from "@earendil-works/pi-ai";

import { isRecord } from "@/utils/type-guards";

export function withMidConversationSystemPrompt(
  existing: SimpleStreamOptions["onPayload"] | undefined,
  systemPrompt: string | undefined,
): SimpleStreamOptions["onPayload"] {
  if (!systemPrompt) return existing;
  return async (payload, model) => {
    let next = payload;
    let upstreamChanged = false;
    const upstream = await existing?.(payload, model);
    if (upstream !== undefined) {
      next = upstream;
      upstreamChanged = true;
    }
    if (!isRecord(next)) {
      return upstreamChanged ? next : undefined;
    }
    const messages = Array.isArray(next.messages) ? next.messages : undefined;
    if (!messages) return upstreamChanged ? next : undefined;
    return {
      ...next,
      messages: insertMidConversationSystemMessage(messages, systemPrompt),
    };
  };
}

// Anthropic only accepts a mid-conversation `system` message after a user turn
// and never as the first item. pi-ai may already end the array with a
// `system` message carrying `output_config.effort` (models with
// supportsMidConvoEffort, e.g. Opus 5 and Fable 5.1); appending blindly would
// put two system messages back to back, with the memory update not following
// a user turn. Insert right after the last non-system message instead. If the
// array has no conversation message yet, do not inject: the backend will fall
// back to a full recompilation on the next turn.
export function insertMidConversationSystemMessage(
  messages: unknown[],
  systemPrompt: string,
): unknown[] {
  let lastConversationIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const entry = messages[index];
    if (
      isRecord(entry) &&
      entry.role !== "system" &&
      entry.role !== "developer"
    ) {
      lastConversationIndex = index;
      break;
    }
  }
  if (lastConversationIndex < 0) return messages;
  return [
    ...messages.slice(0, lastConversationIndex + 1),
    { role: "system", content: systemPrompt },
    ...messages.slice(lastConversationIndex + 1),
  ];
}
