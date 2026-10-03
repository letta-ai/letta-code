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
  source: "command" | "websocket" | "github_pull_request";
  started_at_ms: number;
  status: "running";
  persistent: boolean;
}

export interface WorkflowProgressCounts {
  /** Workers scheduled so far, not a fixed planned total. */
  agents_total: number;
  agents_done: number;
  agents_failed: number;
  agents_running: number;
  total_tokens: number;
}

export interface WorkflowProgressSummary extends WorkflowProgressCounts {
  /** Pipeline phases may run concurrently. */
  phases: Array<WorkflowProgressCounts & { title: string }>;
}

export interface WorkflowBackgroundProcessSummary {
  process_id: string;
  kind: "workflow";
  description: string;
  started_at_ms: number;
  status: "running";
  progress?: WorkflowProgressSummary;
}

export type BackgroundProcessSummary =
  | BashBackgroundProcessSummary
  | AgentTaskBackgroundProcessSummary
  | MonitorBackgroundProcessSummary
  | WorkflowBackgroundProcessSummary;
