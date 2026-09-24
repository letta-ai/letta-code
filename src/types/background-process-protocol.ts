export interface BashBackgroundProcessSummary {
  process_id: string;
  kind: "bash";
  command: string;
  started_at_ms: number | null;
  status: string;
  exit_code: number | null;
  /** Present only for auto-yielded foreground Bash. */
  origin_client_message_ids?: string[];
}

export interface AgentTaskBackgroundProcessSummary {
  process_id: string;
  kind: "agent_task";
  task_type: string;
  description: string;
  started_at_ms: number;
  status: string;
  subagent_id: string | null;
  origin_client_message_ids?: string[];
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
  description: string;
  started_at_ms: number;
  status: "running";
}

export type BackgroundProcessSummary =
  | BashBackgroundProcessSummary
  | AgentTaskBackgroundProcessSummary
  | MonitorBackgroundProcessSummary
  | WorkflowBackgroundProcessSummary;
