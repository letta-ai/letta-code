import { apiRequest } from "./request";

export async function warmSearchCache<T>(
  body: Record<string, unknown>,
): Promise<T> {
  return apiRequest<T>("POST", "/v1/_internal_search/cache-warm", body);
}

export async function searchMessages<T>(
  body: Record<string, unknown>,
): Promise<T> {
  return apiRequest<T>("POST", "/v1/messages/search", body);
}
