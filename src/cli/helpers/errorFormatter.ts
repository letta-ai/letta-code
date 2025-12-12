import { APIError } from "@letta-ai/letta-client/core/error";

/**
 * Extract comprehensive error details from any error object
 * Handles APIError, Error, and other error types consistently
 * @param e The error object to format
 * @param agentId Optional agent ID to create hyperlinks to the Letta dashboard
 */
export function formatErrorDetails(e: unknown, agentId?: string): string {
  let runId: string | undefined;

  // Handle APIError from streaming (event: error)
  if (e instanceof APIError) {
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
          ? `${baseError}\n${createAgentLink(runId, agentId)}`
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
        ? `${baseError}\n${createAgentLink(runId, agentId)}`
        : baseError;
    }

    // Fallback for APIError with just message
    return e.message;
  }

  // Handle regular Error objects
  if (e instanceof Error) {
    return e.message;
  }

  // Fallback for any other type
  return String(e);
}

/**
 * Create a terminal hyperlink to the agent with run ID displayed
 */
function createAgentLink(runId: string, agentId: string): string {
  const url = `https://app.letta.com/agents/${agentId}`;
  return `View agent: \x1b]8;;${url}\x1b\\${agentId}\x1b]8;;\x1b\\ (run: ${runId})`;
}
