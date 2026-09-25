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
}

/** The `export const meta = {...}` literal at the top of every script. */
export interface WorkflowMeta {
  name: string;
  description: string;
  phases?: WorkflowPhaseMeta[];
}

/** Options accepted by the in-script agent() hook. */
export interface AgentCallOptions {
  /** Display label for progress output (defaults to a prompt excerpt). */
  label?: string;
  /** Progress group; overrides the current phase() for this call. */
  phase?: string;
  /**
   * Ask the subagent for a JSON value and resolve to the parsed result. No
   * schema is enforced; a reply that is not valid JSON resolves to null.
   */
  json?: boolean;
  /** JSON Schema for a validated result; takes precedence over json. */
  schema?: Record<string, unknown>;
  /** Model handle or alias for this subagent (defaults to the workflow default). */
  model?: string;
  /** Reasoning effort override ("low" | "medium" | "high" | ...). */
  effort?: string;
  /** Tool allowlist override for this subagent session. */
  allowedTools?: string[];
  /** Extra system prompt appended for this subagent. */
  systemPrompt?: string;
  /** Per-call timeout in milliseconds. */
  timeoutMs?: number;
  /** Maximum unique tool calls for this subagent. Default 1000. */
  maxToolCalls?: number;
}

/** A single request to run one subagent, produced by the agent() hook. */
export interface SubagentRequest {
  prompt: string;
  options: AgentCallOptions;
  /** Sequential id assigned in call order. */
  callIndex: number;
}

/** Outcome of one subagent run. */
export interface SubagentOutcome {
  /** Persisted ephemeral conversation, when one was created. */
  conversationId?: string;
  /** Final text, or the parsed value when `json` was requested. */
  value: unknown;
  /** True when the subagent failed terminally (value is null). */
  failed: boolean;
  /** Optional failure detail for the journal / progress display. */
  error?: string;
  durationMs?: number;
  /** Total tokens consumed by the subagent session (prompt + completion). */
  totalTokens?: number;
}

/** Live signals a spawner may report while a subagent runs. */
export interface SubagentSpawnHooks {
  /** Tokens consumed so far by this subagent (cumulative, per model step). */
  onUsage?: (totalTokens: number) => void;
}

/**
 * Runs one subagent. The SDK-backed implementation lives in sdk-spawner.ts;
 * tests inject fakes.
 */
export type SubagentSpawner = (
  request: SubagentRequest,
  signal: AbortSignal,
  hooks?: SubagentSpawnHooks,
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
      status: "queued" | "running" | "done" | "error";
      detail?: string;
      durationMs?: number;
      totalTokens?: number;
    };

export interface RunWorkflowOptions {
  /** The workflow script source (plain JS, starting with the meta literal). */
  script: string;
  /** Value exposed to the script as the `args` global. */
  args?: unknown;
  /** Max concurrently running subagents. Default 16. */
  maxConcurrent?: number;
  /** Lifetime subagent cap (runaway-loop backstop). Default 1000. */
  maxTotalAgents?: number;
  /** JSONL file that receives one line per completed subagent call. */
  journalPath?: string;
  /** Abort signal for the whole run. */
  signal?: AbortSignal;
  /** Progress callback. */
  onProgress?: (event: WorkflowProgressEvent) => void;
}

export interface WorkflowExecutionResult {
  meta: WorkflowMeta;
  /** The script's return value. */
  result: unknown;
  agentsSpawned: number;
  /** Sum of subagent token usage across the run. */
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
  errorDetail?: string;
  structuredOutput?: unknown;
  durationMs?: number;
  /** Raw Letta stream payload for `type: "stream_event"` messages. */
  event?: Record<string, unknown>;
  /** Tool call details for `type: "tool_call"` / `"tool_result"` messages. */
  toolCallId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  /**
   * Raw, possibly-partial argument fragment from the wire. The SDK emits one
   * `tool_call` message per argument delta; concatenating the fragments for a
   * `toolCallId` yields the complete argument JSON.
   */
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
