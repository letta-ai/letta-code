import { apiRequest } from "./request";

export async function generateAgentResponse<T>(
  agentId: string,
  body: Record<string, unknown>,
  timeout: number,
): Promise<T> {
  return apiRequest<T>("POST", `/v1/agents/${agentId}/generate`, body, {
    // The generated SDK accepted a timeout option here. Use AbortSignal.timeout
    // in the API seam so callers don't need direct raw-client access.
    signal: AbortSignal.timeout(timeout),
  });
}
