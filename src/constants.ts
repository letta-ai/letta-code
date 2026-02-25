/**
 * Application-wide constants
 */

/**
 * Default model ID to use when no model is specified
 */
export const DEFAULT_MODEL_ID = "sonnet-4.5";

/**
 * Default agent name when creating a new agent
 */
export const DEFAULT_AGENT_NAME = "Letta Code";

/**
 * Message displayed when user interrupts tool execution
 */
export const INTERRUPTED_BY_USER = "Interrupted by user";

/**
 * XML tag used to wrap system reminder content injected into messages
 */
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

/**
 * Header displayed before compaction summary when conversation context is truncated
 */
export const COMPACTION_SUMMARY_HEADER =
  "(Earlier messages in this conversation have been compacted to free up context, summarized below)";

/**
 * Status bar thresholds - only show indicators when values exceed these
 */
// Show token count after 100 estimated tokens (shows exact count until 1k, then compact)
export const TOKEN_DISPLAY_THRESHOLD = 100;
// Show elapsed time after 2 minutes (in ms)
export const ELAPSED_DISPLAY_THRESHOLD_MS = 60 * 1000;
