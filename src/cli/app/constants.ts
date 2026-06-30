// Used only for terminal resize, not for dialog dismissal (see PR for details)
export const CLEAR_SCREEN_AND_HOME = "\u001B[2J\u001B[H";
export const MIN_RESIZE_DELTA = 2;
export const RESIZE_SETTLE_MS = 250;
export const MIN_CLEAR_INTERVAL_MS = 750;
export const STABLE_WIDTH_SETTLE_MS = 180;
export const TOOL_CALL_COMMIT_DEFER_MS = 50;
export const ANIMATION_RESUME_HYSTERESIS_ROWS = 2;

// Feature flag: Eagerly cancel streams client-side when user presses ESC
// When true (default), immediately abort the stream after calling .cancel()
// This provides instant feedback to the user without waiting for backend acknowledgment
// When false, wait for backend to send "cancelled" stop_reason (useful for testing backend behavior)
export const EAGER_CANCEL = true;

// Maximum retries for transient LLM API errors (matches headless.ts)
export const LLM_API_ERROR_MAX_RETRIES = 3;

// Retry config for empty response errors (Opus 4.6 SADs)
// Retry 1: same input. Retry 2: with system reminder nudge.
export const EMPTY_RESPONSE_MAX_RETRIES = 2;
export const TEMP_QUOTA_OVERRIDE_MODEL = "letta/auto";

// Provider fallback: Anthropic model ID -> Bedrock model ID.
// After 1 failed retry against Anthropic, automatically retry via Bedrock.
export const PROVIDER_FALLBACK_MAP: Record<string, string> = {
  // Opus 4.7 variants -> Bedrock Opus 4.7
  "opus-4.7-low": "bedrock-opus-4.7",
  "opus-4.7-medium": "bedrock-opus-4.7",
  "opus-4.7-high": "bedrock-opus-4.7",
  "opus-4.7-xhigh": "bedrock-opus-4.7",
  "opus-4.7-max": "bedrock-opus-4.7",
  // Opus 4.6 variants -> Bedrock Opus 4.6
  "opus-4.6-no-reasoning": "bedrock-opus-4.6",
  "opus-4.6-low": "bedrock-opus-4.6",
  "opus-4.6-medium": "bedrock-opus-4.6",
  "opus-4.6-high": "bedrock-opus-4.6",
  "opus-4.6-xhigh": "bedrock-opus-4.6",
  // Sonnet 5 variants -> Bedrock Sonnet 5; Sonnet 4.6 variants -> Bedrock Sonnet 4.6
  sonnet: "bedrock-sonnet-5",
  "sonnet-5-no-reasoning": "bedrock-sonnet-5",
  "sonnet-5-low": "bedrock-sonnet-5",
  "sonnet-5-medium": "bedrock-sonnet-5",
  "sonnet-5-xhigh": "bedrock-sonnet-5",
  "sonnet-4.6": "bedrock-sonnet-4.6",
  "sonnet-1m": "bedrock-sonnet-4.6",
  "sonnet-4.6-no-reasoning": "bedrock-sonnet-4.6",
  "sonnet-4.6-low": "bedrock-sonnet-4.6",
  "sonnet-4.6-medium": "bedrock-sonnet-4.6",
  "sonnet-4.6-xhigh": "bedrock-sonnet-4.6",
};

// Retry config for 409 "conversation busy" errors (exponential backoff)
export const CONVERSATION_BUSY_MAX_RETRIES = 3; // 10s -> 20s -> 40s

// Message shown when user interrupts the stream
export const INTERRUPT_MESSAGE =
  "Interrupted – tell the agent what to do differently. Something went wrong? Use /feedback to report issues.";

// Hint shown after errors to encourage feedback
export const ERROR_FEEDBACK_HINT =
  "Something went wrong? Use /feedback to report issues.";

// Status page URLs for known providers
export const PROVIDER_STATUS_PAGES: Record<
  string,
  { name: string; url: string }
> = {
  anthropic: {
    name: "Anthropic",
    url: "https://status.claude.com/",
  },

  openai: {
    name: "OpenAI",
    url: "https://status.openai.com",
  },
  chatgpt_oauth: {
    name: "OpenAI",
    url: "https://status.openai.com",
  },
};

export const APPROVAL_OPTIONS_HEIGHT = 8;
export const APPROVAL_PREVIEW_BUFFER = 4;
export const MIN_WRAP_WIDTH = 10;
export const TEXT_WRAP_GUTTER = 6;
export const DIFF_WRAP_GUTTER = 12;
export const SHELL_PREVIEW_MAX_LINES = 3;
