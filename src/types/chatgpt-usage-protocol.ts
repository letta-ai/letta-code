export type ChatGPTUsageReadTarget = "local" | "api";

export interface ChatGPTUsageReadCommand {
  type: "chatgpt_usage_read";
  request_id: string;
  target: ChatGPTUsageReadTarget;
  provider_name?: string;
  force_refresh?: boolean;
}

export interface ChatGPTRateLimitResetCreditsListCommand {
  type: "chatgpt_rate_limit_reset_credits_list";
  request_id: string;
  target: ChatGPTUsageReadTarget;
  provider_name?: string;
  force_refresh?: boolean;
}

export interface ChatGPTRateLimitResetCreditConsumeCommand {
  type: "chatgpt_rate_limit_reset_credit_consume";
  request_id: string;
  target: ChatGPTUsageReadTarget;
  provider_name?: string;
  idempotency_key: string;
  reset_id?: string;
}

export interface ChatGPTUsageWindowPayload {
  label: string;
  usedPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface ChatGPTUsageCreditsPayload {
  balance?: string | null;
  availableCount?: number | null;
  hasCredits?: boolean | null;
  unlimited?: boolean | null;
}

export interface ChatGPTUsageIndividualLimitPayload {
  limit: string;
  used: string;
  remainingPercent: number;
  resetsAt: number;
}

export interface ChatGPTUsageSnapshotPayload {
  providerName: string;
  fetchedAt: string;
  summary: string;
  planType?: string | null;
  limitReached?: boolean | null;
  rateLimitReachedType?: string | null;
  primary: ChatGPTUsageWindowPayload | null;
  secondary: ChatGPTUsageWindowPayload | null;
  additional: ChatGPTUsageWindowPayload[];
  credits?: ChatGPTUsageCreditsPayload | null;
  individualLimit?: ChatGPTUsageIndividualLimitPayload | null;
}

export interface ChatGPTRateLimitResetCreditPayload {
  id: string;
  resetType: string;
  status: string;
  grantedAt: string;
  expiresAt: string | null;
  title: string | null;
  description: string | null;
}

export interface ChatGPTRateLimitResetCreditsPayload {
  providerName: string;
  fetchedAt: string;
  availableCount: number;
  credits: ChatGPTRateLimitResetCreditPayload[];
}

export interface ChatGPTUsageReadErrorPayload {
  code:
    | "bad_request"
    | "not_connected"
    | "unsupported_target"
    | "refresh_failed"
    | "unauthorized"
    | "forbidden"
    | "rate_limited"
    | "network_error"
    | "bad_response";
  message: string;
  retryAfterMs?: number;
}

export interface ChatGPTUsageReadResponseMessage {
  type: "chatgpt_usage_read_response";
  request_id: string;
  success: boolean;
  target: ChatGPTUsageReadTarget;
  usage?: ChatGPTUsageSnapshotPayload;
  error?: ChatGPTUsageReadErrorPayload;
}

export interface ChatGPTRateLimitResetCreditsListResponseMessage {
  type: "chatgpt_rate_limit_reset_credits_list_response";
  request_id: string;
  success: boolean;
  target: ChatGPTUsageReadTarget;
  credits?: ChatGPTRateLimitResetCreditsPayload;
  error?: ChatGPTUsageReadErrorPayload;
}

export type ChatGPTRateLimitResetConsumeOutcome =
  | "reset"
  | "nothing_to_reset"
  | "no_credit"
  | "already_redeemed";

export interface ChatGPTRateLimitResetCreditConsumeResponseMessage {
  type: "chatgpt_rate_limit_reset_credit_consume_response";
  request_id: string;
  success: boolean;
  target: ChatGPTUsageReadTarget;
  outcome?: ChatGPTRateLimitResetConsumeOutcome;
  refreshed_usage?: ChatGPTUsageSnapshotPayload;
  refreshed_credits?: ChatGPTRateLimitResetCreditsPayload;
  refresh_error?: ChatGPTUsageReadErrorPayload;
  error?: ChatGPTUsageReadErrorPayload;
}
