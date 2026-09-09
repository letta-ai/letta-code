import { getDesktopAccessToken } from "@/auth/desktop-credentials";
import { getClient } from "@/backend/api/client";

/** Resolve credentials at the start of each Git operation, never persist Desktop OAuth. */
export async function getAuthToken(): Promise<string> {
  const { getBackend } = await import("@/backend");
  const backend = getBackend();
  if (backend.capabilities.localMemfs && !backend.capabilities.remoteMemfs)
    return "";
  const desktopToken = getDesktopAccessToken();
  if (desktopToken) return desktopToken;
  const client = await getClient();
  return client.apiKey ?? "";
}
