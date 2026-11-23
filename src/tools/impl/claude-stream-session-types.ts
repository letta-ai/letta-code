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
  latestInputUuid?: string;
  latestInputStarted: boolean;
  acknowledgesInputs: boolean;
  pendingSteers: number;
  queuedSteer: boolean;
  interruptible: boolean;
  awaitingReplacementStart: boolean;
  suppressedResult?: Record<string, unknown>;
  resultCount: number;
  backgroundTasks: unknown[];
  provisionalResult?: Record<string, unknown>;
  idleOnBackgroundTasks: boolean;
  backgroundCapMs: number;
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
  seenTextBlocks: Set<string>;
  onToolResult?: ExternalWorkerListeners["onToolResult"];
  onReasoning?: ExternalWorkerListeners["onReasoning"];
  toolNames: Map<string, string>;
}

export interface ClaudeTurnOptions
  extends Pick<ExternalWorkerListeners, "onToolResult" | "onReasoning"> {
  traceContext?: ExternalTraceContext;
  prompt: string;
  parentAgentId: string;
  cwd: string;
  cloudSkillRepositories?: string[];
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
  backgroundTaskWaitCapMs?: number;
  controlResponseTimeoutMs?: number;
  settledExitGraceMs?: number;
}
