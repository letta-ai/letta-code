/**
 * Core types for the workflow engine.
 *
 * A workflow is a plain-JavaScript orchestration script that begins with an
 * `export const meta = {...}` pure literal and then drives subagents through
 * the injected hooks: agent(), parallel(), pipeline(), phase(), log().
 *
 * The Letta Agent SDK surface used here is described structurally; the real
 * SDK is loaded lazily at runtime by sdk-loader.ts (see its header for why
 * the import is dynamic).
 */

/** One phase entry in the workflow meta block. */
export interface WorkflowPhaseMeta {
  title: string;
  detail?: string;
  model?: string;
}

/** The `export const meta = {...}` literal at the top of every script. */
export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: WorkflowPhaseMeta[];
}

/** Options accepted by the in-script agent() hook. */
export interface AgentCallOptions {
  /** Display label for progress output (defaults to a prompt excerpt). */
  label?: string;
  /** Progress group; overrides the current phase() for this call. */
  phase?: string;
  /**
   * JSON Schema for structured output. When set, the subagent is given a
   * StructuredOutput tool and agent() resolves to the validated object.
   */
  schema?: Record<string, unknown>;
  /** Model override for this subagent (defaults to the workflow default). */
  model?: string;
  /** Reasoning effort override ("low" | "medium" | "high" | ...). */
  effort?: string;
  /** Tool allowlist override for this subagent session. */
  allowedTools?: string[];
  /** Extra system prompt appended for this subagent. */
  systemPrompt?: string;
  /** Working directory override for this subagent session. */
  cwd?: string;
  /** Per-call timeout in milliseconds. */
  timeoutMs?: number;
}

/** A single request to run one subagent, produced by the agent() hook. */
export interface SubagentRequest {
  prompt: string;
  options: AgentCallOptions;
  /** Stable identity for journaling/resume: hash of prompt + options. */
  cacheKey: string;
  /** Nth occurrence of this cacheKey within the run (0-based). */
  occurrence: number;
  /** Sequential id assigned in call order. */
  callIndex: number;
}

/** Outcome of one subagent run. */
export interface SubagentOutcome {
  /** Final text, or the validated object when a schema was given. */
  value: unknown;
  /** True when the subagent failed terminally (value is null). */
  failed: boolean;
  /** Optional failure detail for the journal / progress display. */
  error?: string;
  costUsd?: number;
  durationMs?: number;
  /** Total tokens consumed by the subagent session (prompt + completion). */
  totalTokens?: number;
}

/**
 * Runs one subagent. The SDK-backed implementation lives in sdk-spawner.ts;
 * the self-test injects fakes.
 */
export type SubagentSpawner = (
  request: SubagentRequest,
  signal: AbortSignal,
) => Promise<SubagentOutcome>;

/** Progress events emitted while a workflow runs. */
export type WorkflowProgressEvent =
  | { kind: "phase"; title: string }
  | { kind: "log"; message: string }
  | {
      kind: "agent";
      callIndex: number;
      label: string;
      phase: string | null;
      status: "queued" | "running" | "done" | "error" | "cached";
      detail?: string;
      /** Set on terminal statuses when the spawner reported them. */
      durationMs?: number;
      totalTokens?: number;
      costUsd?: number;
    };

/** Budget accounting exposed to scripts as `budget` (USD, not tokens). */
export interface WorkflowBudget {
  totalUsd: number | null;
  spentUsd(): number;
  remainingUsd(): number;
}

export interface RunWorkflowOptions {
  /** The workflow script source (plain JS, starting with the meta literal). */
  script: string;
  /** Value exposed to the script as the `args` global. */
  args?: unknown;
  /** Hard USD ceiling for the run; agent() throws once exceeded. */
  budgetUsd?: number;
  /** Max concurrently running subagents. Default min(16, cpus - 2). */
  maxConcurrent?: number;
  /** Lifetime subagent cap (runaway-loop backstop). Default 1000. */
  maxTotalAgents?: number;
  /** Resume: replay journaled results from this prior run. */
  resumeFromExecutionId?: string;
  /** Run id to use instead of generating one (lets callers announce it early). */
  executionId?: string;
  /** Directory that holds run state. Default ~/.letta/workflows/executions. */
  executionsDir?: string;
  /** Abort signal for the whole run. */
  signal?: AbortSignal;
  /** Progress callback. */
  onProgress?: (event: WorkflowProgressEvent) => void;
}

export interface WorkflowExecutionResult {
  executionId: string;
  meta: WorkflowMeta;
  /** The script's return value. */
  result: unknown;
  /** Where the script and journal were persisted. */
  executionDir: string;
  agentsSpawned: number;
  cacheHits: number;
  totalCostUsd: number;
  /** Sum of subagent token usage (live runs only; cached replays add 0). */
  totalTokens: number;
}

// ── Structural view of the Letta Agent SDK surface the engine touches ──────
// (loaded lazily; see sdk-loader.ts)

export interface SdkStreamMessage {
  type: string;
  content?: string;
  success?: boolean;
  result?: string;
  error?: string;
  errorCode?: string;
  totalCostUsd?: number;
  durationMs?: number;
  /** Raw Letta stream payload for `type: "stream_event"` messages. */
  event?: Record<string, unknown>;
}

export interface SdkQuery extends AsyncIterable<SdkStreamMessage> {
  interrupt(): Promise<void>;
  close(): void;
}

export interface SdkToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details?: unknown;
}

/** Matches the SDK's AnyAgentTool shape. */
export interface SdkCustomTool {
  label: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (toolCallId: string, args: unknown) => Promise<SdkToolResult>;
}

export interface SdkClient {
  query(params: { prompt: string; options: Record<string, unknown> }): SdkQuery;
  [Symbol.asyncDispose]?(): Promise<void>;
}
