import { APIError } from "@letta-ai/letta-client/core/error";
import { getErrorContext } from "./errorContext";

const LETTA_USAGE_URL = "https://app.letta.com/settings/organization/usage";
const LETTA_AGENTS_URL =
  "https://app.letta.com/projects/default-project/agents";

/**
 * Check if the error is a rate limit error (429 with exceeded-quota)
 * Returns the timeToQuotaResetMs if it's a rate limit error, undefined otherwise
 */
function getRateLimitResetMs(e: APIError): number | undefined {
  if (e.status !== 429) return undefined;

  const errorBody = e.error;
  if (errorBody && typeof errorBody === "object") {
    // Check for reasons array with "exceeded-quota"
    if ("reasons" in errorBody && Array.isArray(errorBody.reasons)) {
      if (errorBody.reasons.includes("exceeded-quota")) {
        if (
          "timeToQuotaResetMs" in errorBody &&
          typeof errorBody.timeToQuotaResetMs === "number"
        ) {
          return errorBody.timeToQuotaResetMs;
        }
        // Return 0 to indicate rate limited but no reset time available
        return 0;
      }
    }
  }
  return undefined;
}

/**
 * Format a time duration in milliseconds to a human-readable string
 */
function formatResetTime(ms: number): string {
  const now = new Date();
  const resetTime = new Date(now.getTime() + ms);

  // Format the reset time
  const timeStr = resetTime.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  // Calculate human-readable duration
  const totalMinutes = Math.ceil(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  let durationStr: string;
  if (hours > 0 && minutes > 0) {
    durationStr = `${hours}h ${minutes}m`;
  } else if (hours > 0) {
    durationStr = `${hours}h`;
  } else {
    durationStr = `${minutes}m`;
  }

  return `Resets at ${timeStr} (${durationStr})`;
}

/**
 * Check if the error is a resource limit error (402 with "You have reached your limit for X")
 * Returns the error message if it matches, undefined otherwise
 */
function getResourceLimitMessage(e: APIError): string | undefined {
  if (e.status !== 402) return undefined;

  const errorBody = e.error;
  if (errorBody && typeof errorBody === "object") {
    if (
      "error" in errorBody &&
      typeof errorBody.error === "string" &&
      errorBody.error.includes("You have reached your limit for")
    ) {
      return errorBody.error;
    }
  }

  // Also check the message directly
  if (e.message?.includes("You have reached your limit for")) {
    // Extract just the error message part, not the full "402 {...}" string
    const match = e.message.match(/"error":"([^"]+)"/);
    if (match) {
      return match[1];
    }
  }

  return undefined;
}

/**
 * Check if the error is an agent limit error (429 with agents-limit-exceeded)
 */
function isAgentLimitError(e: APIError): boolean {
  if (e.status !== 429) return false;

  const errorBody = e.error;
  if (errorBody && typeof errorBody === "object") {
    if ("reasons" in errorBody && Array.isArray(errorBody.reasons)) {
      if (errorBody.reasons.includes("agents-limit-exceeded")) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Check if the error is a credit exhaustion error (402 with not-enough-credits)
 */
function isCreditExhaustedError(e: APIError): boolean {
  // Check status code
  if (e.status !== 402) return false;

  // Check for "not-enough-credits" in various places it could appear
  const errorBody = e.error;
  if (errorBody && typeof errorBody === "object") {
    // Check reasons array: {"error":"Rate limited","reasons":["not-enough-credits"]}
    if ("reasons" in errorBody && Array.isArray(errorBody.reasons)) {
      if (errorBody.reasons.includes("not-enough-credits")) {
        return true;
      }
    }
    // Check nested error.reasons
    if ("error" in errorBody && typeof errorBody.error === "object") {
      const nested = errorBody.error as Record<string, unknown>;
      if ("reasons" in nested && Array.isArray(nested.reasons)) {
        if (nested.reasons.includes("not-enough-credits")) {
          return true;
        }
      }
    }
  }

  // Also check the message for "not-enough-credits" as a fallback
  if (e.message?.includes("not-enough-credits")) {
    return true;
  }

  return false;
}

const ENCRYPTED_CONTENT_HINT = [
  "",
  "This occurs when the conversation contains messages with encrypted",
  "reasoning from a different OpenAI authentication scope (e.g. switching",
  "between ChatGPT OAuth and an OpenAI API key).",
  "/clear to start a new conversation.",
].join("\n");

/**
 * Walk the error object to find the `detail` string containing the encrypted content error.
 * Handles both direct (e.detail) and nested (e.error.error.detail) structures.
 */
function findEncryptedContentDetail(
  e: unknown,
): string | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const obj = e as Record<string, unknown>;

  // Check direct: e.detail
  if (
    typeof obj.detail === "string" &&
    obj.detail.includes("invalid_encrypted_content")
  ) {
    return obj.detail;
  }

  // Check nested: e.error.error.detail or e.error.detail
  if (obj.error && typeof obj.error === "object") {
    const errObj = obj.error as Record<string, unknown>;
    if (errObj.error && typeof errObj.error === "object") {
      const inner = errObj.error as Record<string, unknown>;
      if (
        typeof inner.detail === "string" &&
        inner.detail.includes("invalid_encrypted_content")
      ) {
        return inner.detail;
      }
    }
    if (
      typeof errObj.detail === "string" &&
      errObj.detail.includes("invalid_encrypted_content")
    ) {
      return errObj.detail;
    }
  }

  return undefined;
}

/**
 * Check if the error contains an encrypted content organization mismatch from OpenAI/ChatGPT.
 * This occurs when switching between ChatGPT OAuth and OpenAI API key auth,
 * leaving encrypted reasoning tokens from a different auth scope in the conversation.
 */
function checkEncryptedContentError(e: unknown): string | undefined {
  // Walk the object structure first (cheap) before falling back to stringify
  const detail = findEncryptedContentDetail(e);
  if (!detail) {
    // Fallback: stringify for edge cases (e.g. plain string errors)
    try {
      const errorStr = typeof e === "string" ? e : JSON.stringify(e);
      if (!errorStr.includes("invalid_encrypted_content")) return undefined;
    } catch {
      return undefined;
    }
    // Detected via stringify but couldn't extract detail — return generic message
    return (
      "OpenAI error: Encrypted content could not be verified — organization mismatch." +
      ENCRYPTED_CONTENT_HINT
    );
  }

  // Try to parse the embedded JSON from the detail string for pretty-printing
  try {
    const jsonStart = detail.indexOf("{");
    if (jsonStart >= 0) {
      const parsed = JSON.parse(detail.slice(jsonStart));
      const innerError = parsed.error || parsed;
      if (innerError.code === "invalid_encrypted_content") {
        const msg = String(
          innerError.message || "Encrypted content verification failed.",
        ).replaceAll('"', '\\"');
        return [
          "OpenAI error:",
          "  {",
          `    type: "${innerError.type || "invalid_request_error"}",`,
          `    code: "${innerError.code}",`,
          `    message: "${msg}"`,
          "  }",
          ENCRYPTED_CONTENT_HINT,
        ].join("\n");
      }
    }
  } catch {
    // Fall through to generic message
  }

  return (
    "OpenAI error: Encrypted content could not be verified — organization mismatch." +
    ENCRYPTED_CONTENT_HINT
  );
}

/**
 * Returns true if the error is an OpenAI encrypted content org mismatch.
 * Used by callers to skip generic error hints for this self-explanatory error.
 */
export function isEncryptedContentError(e: unknown): boolean {
  return findEncryptedContentDetail(e) !== undefined;
}

/**
 * Extract comprehensive error details from any error object
 * Handles APIError, Error, and other error types consistently
 * @param e The error object to format
 * @param agentId Optional agent ID to create hyperlinks to the Letta dashboard
 * @param conversationId Optional conversation ID to include in agent links
 */
export function formatErrorDetails(
  e: unknown,
  agentId?: string,
  conversationId?: string,
): string {
  let runId: string | undefined;

  // Check for OpenAI encrypted content org mismatch before anything else
  const encryptedContentMsg = checkEncryptedContentError(e);
  if (encryptedContentMsg) return encryptedContentMsg;

  // Handle APIError from streaming (event: error)
  if (e instanceof APIError) {
    // Check for rate limit error first - provide a friendly message with reset time
    const rateLimitResetMs = getRateLimitResetMs(e);
    if (rateLimitResetMs !== undefined) {
      const resetInfo =
        rateLimitResetMs > 0
          ? formatResetTime(rateLimitResetMs)
          : "Try again later";
      return `You've hit your usage limit. ${resetInfo}. View usage: ${LETTA_USAGE_URL}`;
    }

    // Check for agent limit error (free tier agent count limit)
    if (isAgentLimitError(e)) {
      const { billingTier } = getErrorContext();

      if (billingTier?.toLowerCase() === "free") {
        return `You've reached the agent limit (3) for the Free Plan. Delete agents at: ${LETTA_AGENTS_URL}\nOr upgrade to Pro for unlimited agents at: ${LETTA_USAGE_URL}`;
      }

      // Fallback for paid tiers (shouldn't normally hit this, but just in case)
      return `You've reached your agent limit. Delete agents at: ${LETTA_AGENTS_URL}\nOr check your plan at: ${LETTA_USAGE_URL}`;
    }

    // Check for resource limit error (e.g., "You have reached your limit for agents")
    const resourceLimitMsg = getResourceLimitMessage(e);
    if (resourceLimitMsg) {
      // Extract the resource type (agents, tools, etc.) from the message
      const match = resourceLimitMsg.match(/limit for (\w+)/);
      const resourceType = match ? match[1] : "resources";
      return `${resourceLimitMsg}\nUpgrade at: ${LETTA_USAGE_URL}\nDelete ${resourceType} at: ${LETTA_AGENTS_URL}`;
    }

    // Check for credit exhaustion error - provide a friendly message
    if (isCreditExhaustedError(e)) {
      const { billingTier, modelDisplayName } = getErrorContext();

      // Free plan users get a special message about BYOK and free models
      if (billingTier?.toLowerCase() === "free") {
        const modelInfo = modelDisplayName ? ` (${modelDisplayName})` : "";
        return `Selected hosted model${modelInfo} not available on Free plan. Switch to a free model with /model (glm-4.7 or minimax-m2.1), upgrade your account at ${LETTA_USAGE_URL}, or connect your own API keys with /connect.`;
      }

      return `Your account is out of credits. Redeem additional credits or configure auto-recharge on your account page: ${LETTA_USAGE_URL}`;
    }
    // Check for nested error structure: e.error.error
    if (e.error && typeof e.error === "object" && "error" in e.error) {
      const errorData = e.error.error;
      if (errorData && typeof errorData === "object") {
        const type = "type" in errorData ? errorData.type : undefined;
        const message =
          "message" in errorData ? errorData.message : "An error occurred";
        const detail = "detail" in errorData ? errorData.detail : undefined;

        const errorType = type ? `[${type}] ` : "";
        const errorDetail = detail ? `\nDetail: ${detail}` : "";

        // Extract run_id from e.error
        if ("run_id" in e.error && typeof e.error.run_id === "string") {
          runId = e.error.run_id;
        }

        const baseError = `${errorType}${message}${errorDetail}`;
        return runId && agentId
          ? `${baseError}\n${createAgentLink(runId, agentId, conversationId)}`
          : baseError;
      }
    }

    // Handle APIError with direct error structure: e.error.detail
    if (e.error && typeof e.error === "object") {
      const detail = "detail" in e.error ? e.error.detail : undefined;
      if ("run_id" in e.error && typeof e.error.run_id === "string") {
        runId = e.error.run_id;
      }

      // When detail is available, prefer showing just the detail to avoid redundancy
      // (e.message often contains the full JSON body like '409 {"detail":"CONFLICT: ..."}')
      const baseError =
        detail && typeof detail === "string" ? detail : e.message;
      return runId && agentId
        ? `${baseError}\n${createAgentLink(runId, agentId, conversationId)}`
        : baseError;
    }

    // Fallback for APIError with just message
    return e.message;
  }

  // Handle regular Error objects
  if (e instanceof Error) {
    return e.message;
  }

  // Fallback for any other type (e.g., plain objects thrown by SDK or other code)
  if (typeof e === "object" && e !== null) {
    const obj = e as Record<string, unknown>;

    // Check common error-like properties
    if (typeof obj.message === "string") {
      return obj.message;
    }
    if (typeof obj.error === "string") {
      return obj.error;
    }
    if (typeof obj.detail === "string") {
      return obj.detail;
    }

    // Last resort: JSON stringify
    try {
      return JSON.stringify(e, null, 2);
    } catch {
      return "[Error: Unable to serialize error object]";
    }
  }

  return String(e);
}

/**
 * Create a terminal hyperlink to the agent with run ID displayed
 */
function createAgentLink(
  runId: string,
  agentId: string,
  conversationId?: string,
): string {
  const url = `https://app.letta.com/agents/${agentId}${conversationId ? `?conversation=${conversationId}` : ""}`;
  return `View agent: \x1b]8;;${url}\x1b\\${agentId}\x1b]8;;\x1b\\ (run: ${runId})`;
}
