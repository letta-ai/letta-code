import { isLocalAgentId as isLocalAgentIdShared } from "@/agent/agent-id";

const CHAT_BASE = "https://chat.letta.com";

export const LETTA_CHAT_API_KEYS_URL = `${CHAT_BASE}/preferences/api-keys`;

export function isLocalAgentId(agentId: string): boolean {
  return isLocalAgentIdShared(agentId);
}

export function buildChatUrl(
  agentId: string,
  options?: {
    conversationId?: string;
    view?: string;
    deviceId?: string;
  },
): string {
  const base = `${CHAT_BASE}/chat/${agentId}`;
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

const DESKTOP_TOKEN_PROTOCOL_PREFIX = "letta-desktop-token.";

export function buildDesktopViewerUrl(
  relayUrl: string,
  expiresAt: string,
  protocols?: string[],
): string {
  const relay = new URL(relayUrl);
  const viewer = new URL("/desktop", CHAT_BASE);
  const token = protocols
    ?.find((protocol) => protocol.startsWith(DESKTOP_TOKEN_PROTOCOL_PREFIX))
    ?.slice(DESKTOP_TOKEN_PROTOCOL_PREFIX.length);
  viewer.hash = new URLSearchParams(
    token
      ? { path: relay.pathname, token, expiresAt }
      : { path: `${relay.pathname}${relay.search}`, expiresAt },
  ).toString();
  return viewer.toString();
}

export function buildAgentReference(
  agentId: string,
  options?: Parameters<typeof buildChatUrl>[1],
): string {
  if (isLocalAgentId(agentId)) {
    return agentId;
  }

  return buildChatUrl(agentId, options);
}

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

export function buildChatWebUrl(path: string): string {
  return `${CHAT_BASE}${path}`;
}
