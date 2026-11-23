export interface WorkflowPhaseMeta {
  title: string;
  detail?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  phases?: WorkflowPhaseMeta[];
}

export interface AgentCallOptions {
  conversationId?: string;
  label?: string;
  phase?: string;
  json?: boolean;
  schema?: Record<string, unknown>;
  model?: string;
  effort?: string;
  allowedTools?: string[];
  systemPrompt?: string;
  skills?: string[];
  timeoutMs?: number;
  maxToolCalls?: number;
}

export interface SubagentRequest {
  prompt: string;
  options: AgentCallOptions;
  callIndex: number;
}

export interface SubagentOutcome {
  conversationId?: string;
  value: unknown;
  failed: boolean;
  error?: string;
  durationMs?: number;
  totalTokens?: number;
  costUsd?: number | null;
}

export interface SubagentSpawnHooks {
  onStarted?: (conversationId: string) => void;
  onUsage?: (totalTokens: number, costUsd?: number | null) => void;
}

export type SubagentSpawner = (
  request: SubagentRequest,
  signal: AbortSignal,
  hooks?: SubagentSpawnHooks,
) => Promise<SubagentOutcome>;

export type WorkflowProgressEvent =
  | { kind: "phase"; title: string }
  | { kind: "log"; message: string }
  | { kind: "decision_usage"; totalTokens: number }
  | {
      kind: "agent";
      callIndex: number;
      label: string;
      phase: string | null;
      status: "queued" | "running" | "done" | "error";
      detail?: string;
      durationMs?: number;
      totalTokens?: number;
    };

export interface RunWorkflowOptions {
  script: string;
  args?: unknown;
  maxConcurrent?: number;
  maxTotalAgents?: number;
  maxTotalDecisions?: number;
  maxCostUsd?: number;
  journalPath?: string;
  signal?: AbortSignal;
  onProgress?: (event: WorkflowProgressEvent) => void;
  callTool?: WorkflowToolCaller;
  builtinToolNames?: readonly string[];
  listTools?: () => Promise<WorkflowToolInfo[]>;
  env?: Readonly<Record<string, string>>;
  maxTotalToolCalls?: number;
}

export interface WorkflowToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface WorkflowToolResult {
  content: unknown[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

export type WorkflowToolCaller = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<WorkflowToolResult>;

export interface WorkflowExecutionResult {
  meta: WorkflowMeta;
  result: unknown;
  agentsSpawned: number;
  totalTokens: number;
  totalCostUsd: number | null;
}

export interface SdkStreamMessage {
  type: string;
  conversationId?: string;
  content?: string;
  success?: boolean;
  result?: string;
  error?: string;
  errorCode?: string;
  errorDetail?: string;
  structuredOutput?: unknown;
  durationMs?: number;
  status?: string;
  event?: Record<string, unknown>;
  toolCallId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  rawArguments?: string;
}

export interface SdkQuery extends AsyncIterable<SdkStreamMessage> {
  readonly agentId?: string | null;
  readonly conversationId?: string | null;
  interrupt(): Promise<void>;
  close(): void;
}

export interface SdkClient {
  query(params: { prompt: string; options: Record<string, unknown> }): SdkQuery;
  [Symbol.asyncDispose]?(): Promise<void>;
}
