const APP_BASE = "https://app.letta.com";

type AgentUrlOptions = {
  conversationId?: string;
  view?: string;
  deviceId?: string;
};

function buildAgentUrl(base: string, options?: AgentUrlOptions): string {
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
 * Build the ADE URL for an agent, with optional conversation and extra query params.
 */
export function buildAdeUrl(
  agentId: string,
  options?: AgentUrlOptions,
): string {
  return buildAgentUrl(`${APP_BASE}/agents/${agentId}`, options);
}

/**
 * Build a chat URL for an agent, with optional conversation and extra query params.
 */
export function buildChatUrl(
  agentId: string,
  options?: AgentUrlOptions,
): string {
  return buildAgentUrl(`${APP_BASE}/chat/${agentId}`, options);
}

/**
 * Build a non-agent app URL (e.g. settings pages).
 */
export function buildAppUrl(path: string): string {
  return `${APP_BASE}${path}`;
}
