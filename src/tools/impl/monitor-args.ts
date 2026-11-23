import type { UrlMonitorMatch } from "./monitor-url-cloud";

export interface MonitorWebSocketSource {
  url: string;
  protocols?: string[];
}

export interface MonitorArgs {
  resume?: string;
  description?: string;
  timeout_ms?: number;
  persistent?: boolean;
  command?: string;
  ws?: MonitorWebSocketSource;
  script?: string;
  args?: unknown;
  url?: string;
  interval_seconds?: number;
  headers?: Record<string, string>;
  select?: string;
  match?: UrlMonitorMatch;
  stop_on_match?: boolean;
  toolCallId?: string;
  backup_after_seconds?: number;
  backup_prompt?: string;
  secretEnv?: Record<string, string>;
  variableEnv?: Record<string, string>;
  parentScope?: { agentId: string; conversationId: string };
  signal?: AbortSignal;
}
