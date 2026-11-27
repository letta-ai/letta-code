import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import { ACTING_USER_ID_HEADER } from "@/agent/acting-user";
import { getModelHandleFromAgent } from "@/agent/subagents/subagent-model";
import {
  type Backend,
  type ConversationMessageListBody,
  getBackend,
} from "@/backend";
import { summarizeConversation } from "@/backend/api/conversations";
import { listProviders } from "@/backend/api/providers";
import { DEFAULT_TITLE_SUMMARIZATION_MODEL } from "@/constants";
import { getConversationTitleSettings } from "@/experiments/conversation-title-settings";
import {
  buildByokProviderAliases,
  isByokHandleForSelector,
} from "@/providers/byok-providers";
import { debugWarn, isDebugEnabled } from "@/utils/debug";

export const CONVERSATION_TITLE_MAX_LENGTH = 100;

export type ConversationTitleMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

const CONVERSATION_TITLE_TIMEOUT_MS = 30_000;

const CONVERSATION_TITLE_SYSTEM_PROMPT = `You are a conversation title generator.

Output ONLY a short, descriptive title for the conversation above.
Rules:
- 2 to 7 words
- describe the actual topic, not the mood
- no quotes, markdown, prefixes, or trailing punctuation
- never call any tools — reply with plain text only
- avoid generic titles like "New conversation" or "Help request"`;

export function normalizeConversationTitle(value: string): string | null {
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

function stripSystemReminders(content: string): string {
  return content
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .trim();
}

function extractUserText(content: unknown): string {
  if (typeof content === "string") {
    return stripSystemReminders(content);
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
    return stripSystemReminders(parts.join("\n"));
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

const CONVERSATION_TITLE_MESSAGE_LIMIT = 10_000;

export async function listConversationTitleMessages(
  backend: Pick<Backend, "listConversationMessages">,
  conversationId: string,
  actingUserId?: string | null,
): Promise<ConversationTitleMessage[]> {
  const page = await backend.listConversationMessages(
    conversationId,
    {
      limit: CONVERSATION_TITLE_MESSAGE_LIMIT,
      order: "desc",
      include_return_message_types: ["user_message", "assistant_message"],
    } as ConversationMessageListBody,
    { headers: { [ACTING_USER_ID_HEADER]: actingUserId } },
  );

  return buildConversationTitleMessages(
    paginatedItems(page as PaginatedItems<Message>).reverse(),
  );
}

export async function generateConversationTitleFromSummary(
  conversationId: string,
  messages: ConversationTitleMessage[],
  model: string = DEFAULT_TITLE_SUMMARIZATION_MODEL,
  actingUserId?: string | null,
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
        actingUserId,
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

export async function generateAiConversationTitle(
  backend: Backend,
  conversationId: string,
  modelHandle?: string | null,
  actingUserId?: string | null,
): Promise<string | null> {
  const messages = await listConversationTitleMessages(
    backend,
    conversationId,
    actingUserId,
  );
  let summaryModel: string | undefined;
  if (modelHandle) {
    const providers = await listProviders({ actingUserId });
    if (
      isByokHandleForSelector(modelHandle, buildByokProviderAliases(providers))
    ) {
      summaryModel = modelHandle;
    }
  }
  return generateConversationTitleFromSummary(
    conversationId,
    messages,
    summaryModel,
    actingUserId,
  );
}

const pendingConversationTitles = new Set<string>();

export async function titleUntitledConversation(
  conversationId: string,
  agentId: string | null,
  actingUserId: string | null,
): Promise<void> {
  if (
    conversationId === "default" ||
    !getConversationTitleSettings().enabled ||
    pendingConversationTitles.has(conversationId)
  )
    return;

  pendingConversationTitles.add(conversationId);
  try {
    const backend = getBackend();
    if (backend.capabilities.localModelCatalog) return;

    const requestOptions = {
      headers: { [ACTING_USER_ID_HEADER]: actingUserId },
    };
    const options = {
      ...requestOptions,
      query: { include_context_message_ids: false },
    };
    const conversation = await backend.retrieveConversation(
      conversationId,
      options,
    );
    if (conversation.summary) return;

    const model =
      getModelHandleFromAgent(conversation) ??
      (agentId
        ? getModelHandleFromAgent(
            await backend.retrieveAgent(agentId, undefined, requestOptions),
          )
        : null);
    const title = await generateAiConversationTitle(
      backend,
      conversationId,
      model,
      actingUserId,
    );
    if (!title) return;

    const latest = await backend.retrieveConversation(conversationId, options);
    if (!latest.summary && getConversationTitleSettings().enabled) {
      await backend.updateConversation(
        conversationId,
        { summary: title },
        { ...requestOptions, maxRetries: 0 },
      );
    }
  } catch (error) {
    debugWarn(
      "conversation-title",
      `Failed to title conversation ${conversationId}`,
      error,
    );
  } finally {
    pendingConversationTitles.delete(conversationId);
  }
}
