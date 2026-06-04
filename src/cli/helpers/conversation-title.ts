import { summarizeConversation } from "@/backend/api/conversations";
import { DEFAULT_SUMMARIZATION_MODEL } from "@/constants";
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

export async function generateConversationTitleFromSummary(
  conversationId: string,
  messages: ConversationTitleMessage[],
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
        model: DEFAULT_SUMMARIZATION_MODEL,
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
