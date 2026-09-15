import type { Letta } from "@letta-ai/letta-client";
import { APIError } from "@letta-ai/letta-client/core/error";
import stripAnsi from "strip-ansi";

export interface ReflectionRunRequest {
  conversation_id: string;
  client_request_id: string;
}

export type ReflectionRunReceipt =
  | { status: "queued"; run_id: string }
  | { status: "no_work" };

export const REFLECTION_UNSUPPORTED =
  "/dream requires an agent stored on Letta Cloud. Local and custom backends are not supported.";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return stripAnsi(value)
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .trim()
    .slice(0, 500);
}

function admissionError(error: APIError): Error {
  const body = record(error.error);
  const detail = record(body?.detail) ?? record(body?.error) ?? body;
  const reason = safeText(detail?.reason ?? detail?.code);
  const message = safeText(detail?.message ?? body?.detail);
  const fallback: Record<number, string> = {
    400: "The reflection request was rejected.",
    401: "Authentication required. Sign in again before retrying /dream.",
    403: "You do not have permission to request reflection for this agent.",
    404: "Reflection is unavailable on this server, or the agent/conversation could not be found.",
    409: "Reflection cannot be queued in the current state.",
    429: "Reflection requests are rate limited. Wait before retrying.",
    503: "Reflection admission is paused or unavailable. Try again later.",
  };
  const summary = fallback[error.status ?? 0] ?? "Reflection request failed.";
  return new Error(
    `${summary} (HTTP ${error.status ?? "unknown"}${reason ? `, ${reason}` : ""})${message ? ` ${message}` : ""}`,
  );
}

/** Enqueue only. SDK credentials (including live Desktop credentials) stay intact. */
export async function postReflectionRun(
  client: Letta,
  agentId: string,
  request: ReflectionRunRequest,
  options?: { headers: Record<string, string> },
): Promise<ReflectionRunReceipt> {
  try {
    const { data, response } = await client
      .post<unknown>(
        `/v1/agents/${encodeURIComponent(agentId)}/reflection/runs`,
        {
          ...options,
          body: {
            conversation_id: request.conversation_id,
            client_request_id: request.client_request_id,
          },
          // Admission failures are decisions, not transport retry signals. A user
          // can retry explicitly; never silently retry a 409/429/503 or denial.
          maxRetries: 0,
          timeout: 30_000,
        },
      )
      .withResponse();
    const receipt = record(data);
    if (
      response.status === 202 &&
      receipt?.status === "queued" &&
      typeof receipt.run_id === "string" &&
      receipt.run_id.trim().length > 0 &&
      Object.keys(receipt).length === 2
    ) {
      return { status: "queued", run_id: receipt.run_id };
    }
    if (
      response.status === 200 &&
      receipt?.status === "no_work" &&
      Object.keys(receipt).length === 1
    ) {
      return { status: "no_work" };
    }
  } catch (error) {
    if (error instanceof APIError) throw admissionError(error);
    throw new Error(
      "No reflection receipt was received. Check your connection before retrying /dream.",
    );
  }
  throw new Error(
    "The server returned an invalid reflection receipt. Reflection has not been confirmed queued.",
  );
}

export function formatReflectionReceipt(receipt: ReflectionRunReceipt): string {
  return receipt.status === "queued"
    ? `Reflection queued. Run ID: ${safeText(receipt.run_id)}`
    : "No new work to reflect on in this conversation.";
}
