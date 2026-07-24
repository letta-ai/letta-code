export const OPENAI_COMPATIBLE_PROXY_UPDATE_ARG = "openai_compatible_proxy";

export function isOfficialOpenAIEndpoint(
  endpoint: string | null | undefined,
): boolean {
  if (!endpoint) return false;
  try {
    return (
      new URL(endpoint).hostname.toLowerCase().replace(/\.$/, "") ===
      "api.openai.com"
    );
  } catch {
    return false;
  }
}

export function isOpenAICompatibleProxyEndpoint(
  endpoint: string | null | undefined,
): boolean {
  if (!endpoint) return false;
  try {
    new URL(endpoint);
    return !isOfficialOpenAIEndpoint(endpoint);
  } catch {
    return false;
  }
}
