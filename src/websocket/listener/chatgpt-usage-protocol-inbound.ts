import type {
  ChatGPTRateLimitResetCreditConsumeCommand,
  ChatGPTRateLimitResetCreditsListCommand,
  ChatGPTUsageReadCommand,
} from "@/types/chatgpt-usage-protocol";

function hasOptionalProviderName(value: { provider_name?: unknown }): boolean {
  return (
    value.provider_name === undefined || typeof value.provider_name === "string"
  );
}

function hasUsageTarget(value: { target?: unknown }): boolean {
  return value.target === "local" || value.target === "api";
}

export function isChatGPTUsageReadCommand(
  value: unknown,
): value is ChatGPTUsageReadCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as {
    type?: unknown;
    request_id?: unknown;
    target?: unknown;
    provider_name?: unknown;
    force_refresh?: unknown;
  };
  return (
    command.type === "chatgpt_usage_read" &&
    typeof command.request_id === "string" &&
    hasUsageTarget(command) &&
    hasOptionalProviderName(command) &&
    (command.force_refresh === undefined ||
      typeof command.force_refresh === "boolean")
  );
}

export function isChatGPTRateLimitResetCreditsListCommand(
  value: unknown,
): value is ChatGPTRateLimitResetCreditsListCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as {
    type?: unknown;
    request_id?: unknown;
    target?: unknown;
    provider_name?: unknown;
    force_refresh?: unknown;
  };
  return (
    command.type === "chatgpt_rate_limit_reset_credits_list" &&
    typeof command.request_id === "string" &&
    hasUsageTarget(command) &&
    hasOptionalProviderName(command) &&
    (command.force_refresh === undefined ||
      typeof command.force_refresh === "boolean")
  );
}

export function isChatGPTRateLimitResetCreditConsumeCommand(
  value: unknown,
): value is ChatGPTRateLimitResetCreditConsumeCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as {
    type?: unknown;
    request_id?: unknown;
    target?: unknown;
    provider_name?: unknown;
    idempotency_key?: unknown;
    reset_id?: unknown;
  };
  return (
    command.type === "chatgpt_rate_limit_reset_credit_consume" &&
    typeof command.request_id === "string" &&
    hasUsageTarget(command) &&
    hasOptionalProviderName(command) &&
    typeof command.idempotency_key === "string" &&
    command.idempotency_key.trim().length > 0 &&
    (command.reset_id === undefined ||
      (typeof command.reset_id === "string" &&
        command.reset_id.trim().length > 0))
  );
}
