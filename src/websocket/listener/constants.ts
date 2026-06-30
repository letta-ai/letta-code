export const MAX_RETRY_DURATION_MS = 5 * 60 * 1000; // 5 minutes
export const INITIAL_RETRY_DELAY_MS = 1000; // 1 second
export const MAX_RETRY_DELAY_MS = 30000; // 30 seconds

export const SYSTEM_REMINDER_RE =
  /<system-reminder>[\s\S]*?<\/system-reminder>/g;

export const LLM_API_ERROR_MAX_RETRIES = 3;
export const EMPTY_RESPONSE_MAX_RETRIES = 2;
export const MAX_PRE_STREAM_RECOVERY = 2;
export const MAX_POST_STOP_APPROVAL_RECOVERY = 2;

// Provider fallback: Anthropic model ID -> Bedrock model ID.
// Mirrors the headless recovery path: after one failed retry against
// Anthropic, retry the same turn using the Bedrock equivalent. Do not map
// generic/latest aliases unless the Bedrock target is the same model family.
export const PROVIDER_FALLBACK_MAP: Record<string, string> = {
  // Opus 4.7 variants -> Bedrock Opus 4.7.
  "opus-4.7-low": "bedrock-opus-4.7",
  "opus-4.7-medium": "bedrock-opus-4.7",
  "opus-4.7-high": "bedrock-opus-4.7",
  "opus-4.7-xhigh": "bedrock-opus-4.7",
  "opus-4.7-max": "bedrock-opus-4.7",
  // Opus 4.6 variants -> Bedrock Opus 4.6.
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

export const PROVIDER_FALLBACK_NOTICE =
  "Anthropic API error; falling back to Bedrock...";
