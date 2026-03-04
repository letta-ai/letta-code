const APP_BASE = "https://app.letta.com";

/**
 * Build a chat URL for an agent, with optional conversation and extra query params.
 */
export function buildChatUrl(
  agentId: string,
  options?: {
    conversationId?: string;
    view?: string;
    deviceId?: string;
  },
): string {
  const base = `${APP_BASE}/chat/${agentId}`;
  const params = new URLSearchParams();

  if (options?.view) {
    params.set("view", options.view);
  }
  if (options?.deviceId) {
    params.set("deviceId", options.deviceId);
  }
  if (options?.conversationId && options.conversationId !== "default") {
    params.set("conversation", options.conversationId);
  }

  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/**
 * Build a non-agent app URL (e.g. settings pages).
 */
export function buildAppUrl(path: string): string {
  return `${APP_BASE}${path}`;
}
