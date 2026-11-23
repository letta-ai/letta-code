import { apiRequest } from "./request";

export async function generateAgentResponse<T>(
  agentId: string,
  body: Record<string, unknown>,
  timeout: number,
): Promise<T> {
  return apiRequest<T>("POST", `/v1/agents/${agentId}/generate`, body, {
    signal: AbortSignal.timeout(timeout),
  });
}
