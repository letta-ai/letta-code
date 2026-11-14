/** Types shared by the Claude Code stream session and its steering logic. */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { SubagentResult } from "@/agent/subagents";
import type { ExternalTraceContext } from "./external-llm-trace-session";
import type {
  ExternalTextListener,
  ExternalToolCallListener,
  ExternalWorkerListeners,
} from "./external-tool-call";

export interface ClaudeSessionTransport {
  process: Pick<ChildProcessWithoutNullStreams, "stdout" | "stderr" | "stdin">;
  completion: Promise<{
    exitCode: number | null;
    exitSignal: NodeJS.Signals | null;
  }>;
  wasAborted(): boolean;
}

export interface PendingControl {
  resolve: () => void;
  reject: (error: Error) => void;
}

export interface TurnWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

export interface ClaudeSession {
  sessionId: string;
  transport: ClaudeSessionTransport;
  model?: string;
  startedAt: number;
  stderr: string;
  report: string;
  protocolError?: string;
  settled: boolean;
  exited: boolean;
  exit: Promise<void>;
  /** UUID of the most recent user input written to stdin. */
  latestInputUuid?: string;
  /** True once Claude has picked up {@link latestInputUuid}. */
  latestInputStarted: boolean;
  /** True once Claude has acknowledged any of our inputs by UUID. */
  acknowledgesInputs: boolean;
  pendingSteers: number;
  /** A steer's prompt was queued before Claude acknowledged its interrupt. */
  queuedSteer: boolean;
  interruptible: boolean;
  awaitingReplacementStart: boolean;
  suppressedResult?: Record<string, unknown>;
  resultCount: number;
  /** Latest `background_tasks_changed.tasks` list; empty until one is seen. */
  backgroundTasks: unknown[];
  /** Last result held back while background tasks were still listed. */
  provisionalResult?: Record<string, unknown>;
  /** True while Claude is idle between turns, waiting on background tasks. */
  idleOnBackgroundTasks: boolean;
  backgroundCapMs: number;
  /** How long a steer waits for Claude to acknowledge its interrupt. */
  controlResponseTimeoutMs: number;
  backgroundCapTimer?: ReturnType<typeof setTimeout>;
  turnWaiters: Set<TurnWaiter>;
  writeLock: Promise<void>;
  completion: Promise<SubagentResult>;
  resolve: (result: SubagentResult) => void;
  pendingControls: Map<string, PendingControl>;
  abortController: AbortController;
  removeUpstreamAbort: () => void;
  onToolCall?: ExternalToolCallListener;
  seenToolCallIds: Set<string>;
  onText?: ExternalTextListener;
  /** Message ID + text of blocks already reported, since messages can repeat. */
  seenTextBlocks: Set<string>;
  onToolResult?: ExternalWorkerListeners["onToolResult"];
  onReasoning?: ExternalWorkerListeners["onReasoning"];
  /** Tool names by `tool_use` ID; an ID leaves once its result is reported. */
  toolNames: Map<string, string>;
}

export interface ClaudeTurnOptions
  extends Pick<ExternalWorkerListeners, "onToolResult" | "onReasoning"> {
  traceContext?: ExternalTraceContext;
  prompt: string;
  parentAgentId: string;
  cwd: string;
  model?: string;
  mcpReminder?: string;
  signal?: AbortSignal;
  resumeSessionId?: string;
  sessionId?: string;
  onStarted?: (sessionId: string) => void;
  onToolCall?: ExternalToolCallListener;
  onText?: ExternalTextListener;
  beforeStart?: () => Promise<void>;
}

export interface ClaudeMessageReceipt {
  mode: "steered" | "resumed";
  /** The steer's prompt is queued behind a turn that hasn't stopped yet. */
  queued?: boolean;
  sessionId: string;
  completion?: Promise<SubagentResult>;
  interrupt?: () => Promise<void>;
}

export interface ClaudeSessionDependencies {
  createTransport?: (options: {
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  }) => ClaudeSessionTransport;
  env?: NodeJS.ProcessEnv;
  createSessionId?: () => string;
  /** Override for {@link BACKGROUND_TASK_WAIT_CAP_MS} (tests). */
  backgroundTaskWaitCapMs?: number;
  /** Override for the interrupt-acknowledgement timeout (tests). */
  controlResponseTimeoutMs?: number;
  /** Override for {@link SETTLED_EXIT_GRACE_MS} (tests). */
  settledExitGraceMs?: number;
}
