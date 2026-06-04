import type Letta from "@letta-ai/letta-client";
import { getBackend } from "@/backend";
import { getClient } from "@/backend/api/client";
import {
  forkConversation,
  updateConversationDescription,
} from "@/backend/api/conversations";
import { DEFAULT_SUMMARIZATION_MODEL } from "@/constants";
import { experimentManager } from "@/experiments/manager";
import { isDebugEnabled } from "@/utils/debug";

type ConversationDescriptionCreateBody = Parameters<
  Letta["conversations"]["messages"]["create"]
>[1] & { llm_call_type: "chat_summary" };

const CONVERSATION_DESCRIPTION_MAX_WORDS = 40;

/**
 * Hard timeout on the fork-and-generate flow. Description generation is
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

const CONVERSATION_DESCRIPTION_USER_PROMPT =
  "Based on the conversation above, output a concise internal description for search and bootstrap context. Reply with ONLY the description text — no quotes, no tools, no preamble.";

function trimToWordLimit(value: string, maxWords: number): string {
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) {
    return value;
  }
  return words.slice(0, maxWords).join(" ");
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

export async function generateConversationDescriptionFromFork(
  client: Letta,
  conversationId: string,
): Promise<string | null> {
  let forkId: string | null = null;
  const abortController = new AbortController();
  const timeoutId = setTimeout(
    () => abortController.abort(),
    CONVERSATION_DESCRIPTION_TIMEOUT_MS,
  );

  try {
    const fork = await forkConversation(conversationId, { hidden: true });
    forkId = fork.id;

    const stream = await client.conversations.messages.create(
      forkId,
      {
        messages: [
          {
            role: "user",
            content: CONVERSATION_DESCRIPTION_USER_PROMPT,
          },
        ],
        override_model: DEFAULT_SUMMARIZATION_MODEL,
        override_system: CONVERSATION_DESCRIPTION_SYSTEM_PROMPT,
        max_steps: 1,
        streaming: true,
        stream_tokens: false,
        include_pings: false,
        llm_call_type: "chat_summary",
      } as ConversationDescriptionCreateBody,
      { signal: abortController.signal },
    );

    let descriptionText = "";
    for await (const chunk of stream) {
      if (
        chunk &&
        typeof chunk === "object" &&
        "message_type" in chunk &&
        (chunk as { message_type?: string }).message_type ===
          "assistant_message"
      ) {
        descriptionText += extractAssistantText(
          (chunk as { content?: unknown }).content,
        );
      }
    }

    return normalizeConversationDescription(descriptionText);
  } catch (err) {
    if (isDebugEnabled()) {
      console.error(
        "[DEBUG] generateConversationDescriptionFromFork failed:",
        err,
      );
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
    if (forkId) {
      void client.conversations.delete(forkId).catch((err) => {
        if (isDebugEnabled()) {
          console.error(
            "[DEBUG] failed to delete description-fork conversation:",
            err,
          );
        }
      });
    }
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
    const client = await getClient();
    const description = await generateConversationDescriptionFromFork(
      client,
      conversationId,
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
