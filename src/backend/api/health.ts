import { apiRequest } from "./request";

export interface ServerHealth {
  version?: string;
}

export async function getServerHealth(options?: {
  baseUrl?: string;
  signal?: AbortSignal;
}): Promise<ServerHealth> {
  return apiRequest<ServerHealth>("GET", "/v1/health", undefined, {
    baseUrl: options?.baseUrl,
    signal: options?.signal,
  });
}
