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
export const DEFAULT_AGENT_NAME = "Nameless Agent";

/**
 * Message displayed when user interrupts tool execution
 */
export const INTERRUPTED_BY_USER = "Interrupted by user";

/**
 * Status bar thresholds - only show indicators when values exceed these
 */
// Show token count after 100 estimated tokens (shows exact count until 1k, then compact)
export const TOKEN_DISPLAY_THRESHOLD = 100;
// Show elapsed time after 2 minutes (in ms)
export const ELAPSED_DISPLAY_THRESHOLD_MS = 2 * 60 * 1000;

/**
 * Polling interval for checking remote-triggered tool calls (in ms)
 * Can be overridden via LETTA_POLL_INTERVAL environment variable
 */
export const DEFAULT_POLL_INTERVAL_MS = 5000;
