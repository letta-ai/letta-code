export interface BashBackgroundProcessSummary {
  process_id: string;
  kind: "bash";
  command: string;
  started_at_ms: number | null;
  status: string;
  exit_code: number | null;
}

export interface AgentTaskBackgroundProcessSummary {
  process_id: string;
  kind: "agent_task";
  task_type: string;
  description: string;
  started_at_ms: number;
  status: string;
  subagent_id: string | null;
  error?: string;
}

export interface MonitorBackgroundProcessSummary {
  process_id: string;
  kind: "monitor";
  description: string;
  source: "command" | "websocket";
  started_at_ms: number;
  status: "running";
  persistent: boolean;
}

export type BackgroundProcessSummary =
  | BashBackgroundProcessSummary
  | AgentTaskBackgroundProcessSummary
  | MonitorBackgroundProcessSummary;
