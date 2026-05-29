export const DEFAULT_LOCAL_ANALYTICS_PORT = 45454;
export const DEFAULT_LOCAL_ANALYTICS_URL = `http://127.0.0.1:${DEFAULT_LOCAL_ANALYTICS_PORT}`;
export const LOCAL_ANALYTICS_ENV = "LETTA_LOCAL_ANALYTICS";
export const LOCAL_ANALYTICS_URL_ENV = "LETTA_LOCAL_ANALYTICS_URL";

export interface LocalAnalyticsUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  totalTokens?: number;
}

export interface LocalAnalyticsAnthropicUsageEvent {
  type: "anthropic_usage";
  timestamp: number;
  instanceId: string;
  processId: number;
  hostname: string;
  cwd: string;
  agentId: string;
  conversationId: string;
  model: string;
  provider: "anthropic";
  responseModel?: string;
  requestId?: string;
  latencyMs: number;
  ttftMs?: number;
  streamed: boolean;
  usage: LocalAnalyticsUsage;
}

export type LocalAnalyticsEvent = LocalAnalyticsAnthropicUsageEvent;

export function localAnalyticsUrlFromEnv(): string | null {
  const explicitUrl = process.env[LOCAL_ANALYTICS_URL_ENV]?.trim();
  if (explicitUrl) return explicitUrl.replace(/\/+$/, "");

  const enabled = process.env[LOCAL_ANALYTICS_ENV]?.trim().toLowerCase();
  if (enabled === "1" || enabled === "true" || enabled === "yes") {
    return DEFAULT_LOCAL_ANALYTICS_URL;
  }

  return null;
}

export function isLocalAnalyticsEnabled(): boolean {
  return localAnalyticsUrlFromEnv() !== null;
}
