
export const DEFAULT_TITLE_SUMMARIZATION_MODEL = "openai/gpt-6-luna";

export const DEFAULT_AGENT_NAME = "Letta Code";

export const INTERRUPTED_BY_USER = "Interrupted by user";

/**
 * Synthetic tool result injected when a turn ended without completing all tool calls
 * (e.g. process crash or unhandled stream error). Settled automatically at the start
 * of the next turn so the conversation history stays valid for the provider.
 */
export const TURN_DID_NOT_COMPLETE = "Turn did not complete";

export const SYSTEM_REMINDER_TAG = "system-reminder";
export const SYSTEM_REMINDER_OPEN = `<${SYSTEM_REMINDER_TAG}>`;
export const SYSTEM_REMINDER_CLOSE = `</${SYSTEM_REMINDER_TAG}>`;
// Legacy tag kept for parsing/backward compatibility with older saved messages.
export const SYSTEM_ALERT_TAG = "system-alert";
export const SYSTEM_ALERT_OPEN = `<${SYSTEM_ALERT_TAG}>`;
export const SYSTEM_ALERT_CLOSE = `</${SYSTEM_ALERT_TAG}>`;

/**
 * How often (in turns) to check for memfs sync conflicts, even without
 * filesystem change events. Catches block-only changes (e.g. ADE/API edits).
 */
export const MEMFS_CONFLICT_CHECK_INTERVAL = 5;

export const COMPACTION_SUMMARY_HEADER =
  "(Earlier messages in this conversation have been compacted to free up context, summarized below)";

// Show token count after 100 estimated tokens (shows exact count until 1k, then compact)
export const TOKEN_DISPLAY_THRESHOLD = 100;
export const ELAPSED_DISPLAY_THRESHOLD_MS = 60 * 1000;
