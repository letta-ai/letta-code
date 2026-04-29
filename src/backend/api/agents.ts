import { apiRequest } from "./request";

export async function getAgentContextOverview<T>(
  agentId: string,
  options?: { signal?: AbortSignal },
): Promise<T> {
  return apiRequest<T>("GET", `/v1/agents/${agentId}/context`, undefined, {
    signal: options?.signal,
  });
}

export async function createMinimalAgent(
  apiKey: string,
  name: string,
): Promise<{ id: string; name: string }> {
  return apiRequest<{ id: string; name: string }>(
    "POST",
    "/v1/agents",
    { name },
    {
      baseUrl: "https://api.letta.com",
      apiKey,
    },
  );
}
