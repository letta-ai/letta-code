export const CLEAR_SCREEN_AND_HOME = "\u001B[2J\u001B[H";
export const MIN_RESIZE_DELTA = 2;
export const RESIZE_SETTLE_MS = 250;
export const MIN_CLEAR_INTERVAL_MS = 750;
export const STABLE_WIDTH_SETTLE_MS = 180;
export const TOOL_CALL_COMMIT_DEFER_MS = 50;
export const ANIMATION_RESUME_HYSTERESIS_ROWS = 2;

export const EAGER_CANCEL = true;

export const LLM_API_ERROR_MAX_RETRIES = 3;

export const EMPTY_RESPONSE_MAX_RETRIES = 2;

export const CONVERSATION_BUSY_MAX_RETRIES = 3;

export const INTERRUPT_MESSAGE =
  "Interrupted – tell the agent what to do differently. Something went wrong? Use /feedback to report issues.";

export const ERROR_FEEDBACK_HINT =
  "Something went wrong? Use /feedback to report issues.";

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
