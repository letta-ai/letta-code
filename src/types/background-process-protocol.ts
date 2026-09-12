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

export interface WorkflowBackgroundProcessSummary {
  process_id: string;
  kind: "workflow";
  name: string;
  description: string;
  execution_id: string;
  started_at_ms: number;
  status: "running";
  agents_done: number;
  agents_total: number;
  total_tokens: number;
}

export type BackgroundProcessSummary =
  | BashBackgroundProcessSummary
  | AgentTaskBackgroundProcessSummary
  | MonitorBackgroundProcessSummary
  | WorkflowBackgroundProcessSummary;
