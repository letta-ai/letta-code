import type Letta from "@letta-ai/letta-client";
import { forkConversation } from "@/backend/api/conversations";
import { DEFAULT_SUMMARIZATION_MODEL } from "@/constants";
import { isDebugEnabled } from "@/utils/debug";

/**
 * Maximum characters allowed for an auto-generated conversation title.
 */
export const CONVERSATION_TITLE_MAX_LENGTH = 100;

/**
 * Hard timeout on the fork-and-generate flow. Title generation is best-effort
 * and we fall back to a heuristic on timeout.
 */
const CONVERSATION_TITLE_TIMEOUT_MS = 30_000;

/**
 * System prompt installed via `override_system` for the title-generation turn.
 * Bypasses the agent's persisted system prompt so the model focuses on producing
 * a single short title rather than its normal task behavior.
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
 * Final user-turn prompt sent to the forked conversation. The agent already
 * has the original conversation's in-context messages (copied by fork), so
 * this just nudges it to emit the title.
 */
const CONVERSATION_TITLE_USER_PROMPT =
  "Based on the conversation above, output a short title (2-7 words) describing the topic. Reply with ONLY the title text — no quotes, no tools, no preamble.";

/**
 * Strip whitespace, surrounding quotes, and clamp to {@link CONVERSATION_TITLE_MAX_LENGTH}.
 * Returns null when the input doesn't yield a usable title (empty, slash command, etc.).
 */

export function shouldPersistAutoConversationTitle(
  conversationId: string | null | undefined,
  backendCapabilities: { localModelCatalog?: boolean },
): boolean {
  if (!conversationId) {
    return false;
  }

  return (
    conversationId !== "default" ||
    backendCapabilities.localModelCatalog === true
  );
}

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

/**
 * Generate a conversation title by:
 * 1. Forking the conversation as a hidden side conversation.
 * 2. Sending a single one-step message to the fork with `override_model`
 *    (DEFAULT_SUMMARIZATION_MODEL) and `override_system` so the agent only
 *    emits a short title rather than running its full task loop.
 * 3. Reading the assistant message text out of the stream.
 * 4. Best-effort deleting the forked conversation so it doesn't pollute
 *    the user's conversation list.
 *
 * Returns null on any failure or when the model produced empty output —
 * the caller should fall back to a heuristic title.
 */
export async function generateConversationTitleFromFork(
  client: Letta,
  conversationId: string,
): Promise<string | null> {
  let forkId: string | null = null;
  const abortController = new AbortController();
  const timeoutId = setTimeout(
    () => abortController.abort(),
    CONVERSATION_TITLE_TIMEOUT_MS,
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
            content: CONVERSATION_TITLE_USER_PROMPT,
          },
        ],
        override_model: DEFAULT_SUMMARIZATION_MODEL,
        override_system: CONVERSATION_TITLE_SYSTEM_PROMPT,
        max_steps: 1,
        streaming: true,
        stream_tokens: false,
        include_pings: false,
      },
      { signal: abortController.signal },
    );

    let titleText = "";
    for await (const chunk of stream) {
      // Only collect assistant_message text. Tool calls / reasoning are ignored
      // so a model that misbehaves and tries a tool call still falls back cleanly.
      if (
        chunk &&
        typeof chunk === "object" &&
        "message_type" in chunk &&
        (chunk as { message_type?: string }).message_type ===
          "assistant_message"
      ) {
        titleText += extractAssistantText(
          (chunk as { content?: unknown }).content,
        );
      }
    }

    return normalizeConversationTitle(titleText);
  } catch (err) {
    if (isDebugEnabled()) {
      console.error("[DEBUG] generateConversationTitleFromFork failed:", err);
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
    // Best-effort cleanup of the hidden fork. We don't await this on the
    // hot path; if it errors we just leave the hidden convo and move on.
    if (forkId) {
      void client.conversations.delete(forkId).catch((err) => {
        if (isDebugEnabled()) {
          console.error(
            "[DEBUG] failed to delete title-fork conversation:",
            err,
          );
        }
      });
    }
  }
}
