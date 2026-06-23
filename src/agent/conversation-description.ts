import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import { getBackend } from "@/backend";
import {
  summarizeConversation,
  updateConversationDescription,
} from "@/backend/api/conversations";
import { DEFAULT_SUMMARIZATION_MODEL } from "@/constants";
import { experimentManager } from "@/experiments/manager";
import { isDebugEnabled } from "@/utils/debug";

const CONVERSATION_DESCRIPTION_MAX_WORDS = 40;
const CONVERSATION_DESCRIPTION_MESSAGE_LIMIT = 40;

/**
 * Hard timeout on the summarize endpoint flow. Description generation is
 * best-effort and should never block the main conversation path indefinitely.
 */
const CONVERSATION_DESCRIPTION_TIMEOUT_MS = 30_000;

const CONVERSATION_DESCRIPTION_SYSTEM_PROMPT = `You generate short internal conversation descriptions.

Output ONLY a concise description of the conversation above.
Rules:
- up to 40 words
- capture the concrete topic, the user's goal, and any meaningful constraints or decisions
- no quotes, markdown, bullets, prefixes, or trailing punctuation
- never call any tools — reply with plain text only
- ignore setup noise like tool chatter, system reminders, approvals, and boilerplate unless the conversation is explicitly about them`;

export type ConversationDescriptionMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

function trimToWordLimit(value: string, maxWords: number): string {
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) {
    return value;
  }
  return words.slice(0, maxWords).join(" ");
}

type PaginatedItems<T> = T[] | { getPaginatedItems?: () => T[] };

function paginatedItems<T>(value: PaginatedItems<T>): T[] {
  if (Array.isArray(value)) return value;
  return value.getPaginatedItems?.() ?? [];
}

export function normalizeConversationDescription(value: string): string | null {
  let normalized = value.replace(/\s+/g, " ").trim();

  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }

  if (!normalized || normalized.startsWith("/")) {
    return null;
  }

  return trimToWordLimit(normalized, CONVERSATION_DESCRIPTION_MAX_WORDS);
}

/**
 * Extract plain-text content from an assistant_message chunk's `content`
 * field, which may be a raw string or an array of structured content parts.
 */
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

function messageToDescriptionMessage(
  message: Message,
): ConversationDescriptionMessage | null {
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

export function buildConversationDescriptionMessages(
  messages: Message[],
): ConversationDescriptionMessage[] {
  const descriptionMessages: ConversationDescriptionMessage[] = [];
  for (const message of messages) {
    const descriptionMessage = messageToDescriptionMessage(message);
    if (descriptionMessage) {
      descriptionMessages.push(descriptionMessage);
    }
  }
  return descriptionMessages;
}

export async function generateConversationDescriptionFromSummary(
  conversationId: string,
  messages: ConversationDescriptionMessage[],
  model: string = DEFAULT_SUMMARIZATION_MODEL,
): Promise<string | null> {
  if (messages.length === 0) {
    return null;
  }

  const abortController = new AbortController();
  const timeoutId = setTimeout(
    () => abortController.abort(),
    CONVERSATION_DESCRIPTION_TIMEOUT_MS,
  );

  try {
    const response = await summarizeConversation(
      conversationId,
      {
        prompt: CONVERSATION_DESCRIPTION_SYSTEM_PROMPT,
        messages,
        model,
      },
      {
        signal: abortController.signal,
      },
    );
    return normalizeConversationDescription(response.summary);
  } catch (err) {
    if (isDebugEnabled()) {
      console.error(
        "[DEBUG] generateConversationDescriptionFromSummary failed:",
        err,
      );
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function regenerateConversationDescription(
  conversationId: string | null | undefined,
): Promise<boolean> {
  if (!experimentManager.isEnabled("desktop_conversation_bootstrap")) {
    return false;
  }
  if (getBackend().capabilities.localModelCatalog) {
    return false;
  }
  if (!conversationId || conversationId === "default") {
    return false;
  }

  try {
    const page = await getBackend().listConversationMessages(conversationId, {
      limit: CONVERSATION_DESCRIPTION_MESSAGE_LIMIT,
      order: "desc",
      include_return_message_types: ["user_message", "assistant_message"],
    });
    const messages = buildConversationDescriptionMessages(
      paginatedItems(page as PaginatedItems<Message>).reverse(),
    );
    const description = await generateConversationDescriptionFromSummary(
      conversationId,
      messages,
      DEFAULT_SUMMARIZATION_MODEL,
    );
    if (!description) {
      return false;
    }

    await updateConversationDescription(conversationId, { description });
    return true;
  } catch (err) {
    if (isDebugEnabled()) {
      console.error("[DEBUG] regenerateConversationDescription failed:", err);
    }
    return false;
  }
}
