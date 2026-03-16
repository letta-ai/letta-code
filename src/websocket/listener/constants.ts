export const MAX_RETRY_DURATION_MS = 5 * 60 * 1000; // 5 minutes
export const INITIAL_RETRY_DELAY_MS = 1000; // 1 second
export const MAX_RETRY_DELAY_MS = 30000; // 30 seconds

export const SYSTEM_REMINDER_RE =
  /<system-reminder>[\s\S]*?<\/system-reminder>/g;

export const LLM_API_ERROR_MAX_RETRIES = 3;
export const EMPTY_RESPONSE_MAX_RETRIES = 2;
export const MAX_PRE_STREAM_RECOVERY = 2;
export const MAX_POST_STOP_APPROVAL_RECOVERY = 2;

export const NO_AWAITING_APPROVAL_DETAIL_FRAGMENT =
  "no tool call is currently awaiting approval";
