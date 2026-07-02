import { isLocalAgentId as isLocalAgentIdShared } from "@/agent/agent-id";

const APP_BASE = "https://app.letta.com";

export function isLocalAgentId(agentId: string): boolean {
  return isLocalAgentIdShared(agentId);
}

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
 * Build a user-facing agent reference. API-backed agents can link to the app,
 * but local-backend agents are not available at app.letta.com, so show the ID.
 */
export function buildAgentReference(
  agentId: string,
  options?: Parameters<typeof buildChatUrl>[1],
): string {
  if (isLocalAgentId(agentId)) {
    return agentId;
  }

  return buildChatUrl(agentId, options);
}

/**
 * Build an OSC8 terminal hyperlink for API-backed agents, or plain text for
 * local-backend agents that do not exist in the web app.
 */
export function buildAgentTerminalLink(
  agentId: string,
  options?: Parameters<typeof buildChatUrl>[1],
  label: string = agentId,
): string {
  if (isLocalAgentId(agentId)) {
    return agentId;
  }

  const url = buildChatUrl(agentId, options);
  return `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
}

/**
 * Build a non-agent app URL (e.g. settings pages).
 */
export function buildAppUrl(path: string): string {
  return `${APP_BASE}${path}`;
}
