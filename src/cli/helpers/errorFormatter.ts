import { APIError } from "@letta-ai/letta-client/core/error";

const LETTA_USAGE_URL = "https://app.letta.com/settings/organization/usage";

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

  // Handle APIError from streaming (event: error)
  if (e instanceof APIError) {
    // Check for credit exhaustion error first - provide a friendly message
    if (isCreditExhaustedError(e)) {
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

      const baseError = detail ? `${e.message}\nDetail: ${detail}` : e.message;
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
