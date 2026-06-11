import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import type { Backend, ConversationMessageListBody } from "@/backend";
import { summarizeConversation } from "@/backend/api/conversations";
import { DEFAULT_TITLE_SUMMARIZATION_MODEL } from "@/constants";
import { settingsManager } from "@/settings-manager";
import { isDebugEnabled } from "@/utils/debug";

/**
 * Maximum characters allowed for an auto-generated conversation title.
 */
export const CONVERSATION_TITLE_MAX_LENGTH = 100;

export type ConversationTitleMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export interface ConversationTitleSettingsSnapshot {
  enabled: boolean;
}

export function getConversationTitleSettings(): ConversationTitleSettingsSnapshot {
  try {
    return {
      enabled: settingsManager.getSettings().autoConversationTitles === true,
    };
  } catch {
    return { enabled: false };
  }
}

export function setConversationTitleSettings(
  enabled: boolean,
): ConversationTitleSettingsSnapshot {
  settingsManager.updateSettings({ autoConversationTitles: enabled });
  return getConversationTitleSettings();
}

/**
 * Hard timeout on title generation. Title generation is best-effort and we
 * fall back to a heuristic on timeout.
 */
const CONVERSATION_TITLE_TIMEOUT_MS = 30_000;

/**
 * System prompt for server-side title summarization.
 */
const CONVERSATION_TITLE_SYSTEM_PROMPT = `You are a conversation title generator.

Output ONLY a short, descriptive title for the conversation above.
Rules:
- 2 to 7 words
- describe the actual topic, not the mood
- no quotes, markdown, prefixes, or trailing punctuation
- never call any tools — reply with plain text only
- avoid generic titles like "New conversation" or "Help request"`;

/**
 * Strip whitespace, surrounding quotes, and clamp to {@link CONVERSATION_TITLE_MAX_LENGTH}.
 * Returns null when the input doesn't yield a usable title (empty, slash command, etc.).
 */
export function normalizeConversationTitle(value: string): string | null {
  let normalized = value.replace(/\s+/g, " ").trim();

  // Drop a single layer of surrounding quotes if the model added them despite the prompt.
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }

  if (!normalized || normalized.startsWith("/")) {
    return null;
  }

  return normalized.slice(0, CONVERSATION_TITLE_MAX_LENGTH);
}

type PaginatedItems<T> = T[] | { getPaginatedItems?: () => T[] };

function paginatedItems<T>(value: PaginatedItems<T>): T[] {
  if (Array.isArray(value)) return value;
  return value.getPaginatedItems?.() ?? [];
}

function extractAssistantText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    let collected = "";
    for (const part of content) {
      if (
        part &&
        typeof part === "object" &&
        "text" in part &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        collected += (part as { text: string }).text;
      }
    }
    return collected;
  }
  return "";
}

function extractUserText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const record = part as { type?: unknown; text?: unknown };
      if (typeof record.text === "string") {
        parts.push(record.text);
      } else if (record.type === "image") {
        parts.push("[image]");
      }
    }
    return parts.join("\n");
  }
  return "";
}

function messageToTitleMessage(
  message: Message,
): ConversationTitleMessage | null {
  if (message.message_type === "user_message") {
    const content = extractUserText(message.content).trim();
    return content ? { role: "user", content } : null;
  }
  if (message.message_type === "assistant_message") {
    const content = extractAssistantText(message.content).trim();
    return content ? { role: "assistant", content } : null;
  }
  return null;
}

export function buildConversationTitleMessages(
  messages: Message[],
): ConversationTitleMessage[] {
  const titleMessages: ConversationTitleMessage[] = [];
  for (const message of messages) {
    const titleMessage = messageToTitleMessage(message);
    if (titleMessage) {
      titleMessages.push(titleMessage);
    }
  }
  return titleMessages;
}

const CONVERSATION_TITLE_MESSAGE_PAGE_LIMIT = 100;

export async function listConversationTitleMessages(
  backend: Pick<Backend, "listConversationMessages">,
  conversationId: string,
): Promise<ConversationTitleMessage[]> {
  const collected: Message[] = [];
  const seenIds = new Set<string>();
  let cursorBefore: string | undefined;

  while (true) {
    const page = await backend.listConversationMessages(conversationId, {
      limit: CONVERSATION_TITLE_MESSAGE_PAGE_LIMIT,
      order: "desc",
      include_return_message_types: ["user_message", "assistant_message"],
      ...(cursorBefore ? { before: cursorBefore } : {}),
    } as ConversationMessageListBody);
    const items = paginatedItems(page as PaginatedItems<Message>);
    if (items.length === 0) {
      break;
    }

    let newItems = 0;
    for (const item of items) {
      const id = item.id;
      if (!id || seenIds.has(id)) {
        continue;
      }
      seenIds.add(id);
      collected.push(item);
      newItems += 1;
    }

    if (newItems === 0) {
      break;
    }
    cursorBefore = items[items.length - 1]?.id;
    if (!cursorBefore) {
      break;
    }
  }

  return buildConversationTitleMessages(collected.reverse());
}

export async function generateConversationTitleFromSummary(
  conversationId: string,
  messages: ConversationTitleMessage[],
  model: string = DEFAULT_TITLE_SUMMARIZATION_MODEL,
): Promise<string | null> {
  if (messages.length === 0) {
    return null;
  }

  const abortController = new AbortController();
  const timeoutId = setTimeout(
    () => abortController.abort(),
    CONVERSATION_TITLE_TIMEOUT_MS,
  );

  try {
    const response = await summarizeConversation(
      conversationId,
      {
        prompt: CONVERSATION_TITLE_SYSTEM_PROMPT,
        messages,
        model,
      },
      {
        signal: abortController.signal,
      },
    );
    return normalizeConversationTitle(response.summary);
  } catch (err) {
    if (isDebugEnabled()) {
      console.error(
        "[DEBUG] generateConversationTitleFromSummary failed:",
        err,
      );
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
