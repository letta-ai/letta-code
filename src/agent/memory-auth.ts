import { getSessionAccessToken } from "@/auth/org-credentials-session";
import { getClient } from "@/backend/api/client";

/** Resolve credentials at the start of each Git operation, never persist Desktop OAuth. */
export async function getAuthToken(): Promise<string> {
  const { getBackend } = await import("@/backend");
  const backend = getBackend();
  if (backend.capabilities.localMemfs && !backend.capabilities.remoteMemfs)
    return "";
  const sessionToken = await getSessionAccessToken();
  if (sessionToken) return sessionToken;
  const client = await getClient();
  return client.apiKey ?? "";
}
