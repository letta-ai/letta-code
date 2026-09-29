import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Writable } from "node:stream";
import type { SubagentResult } from "@/agent/subagents";
import {
  type RunningSubagentProcess,
  spawnSubagentProcess,
} from "@/agent/subagents/subagent-process";
import { LIMITS } from "./truncation";

export interface ClaudeSessionTransport {
  process: Pick<ChildProcessWithoutNullStreams, "stdout" | "stderr" | "stdin">;
  completion: Promise<{
    exitCode: number | null;
    exitSignal: NodeJS.Signals | null;
  }>;
  wasAborted(): boolean;
}

interface PendingControl {
  resolve: () => void;
  reject: (error: Error) => void;
}

interface TurnWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

interface ClaudeSession {
  sessionId: string;
  transport: ClaudeSessionTransport;
  model?: string;
  startedAt: number;
  stderr: string;
  report: string;
  protocolError?: string;
  settled: boolean;
  pendingSteers: number;
  interruptible: boolean;
  awaitingReplacementStart: boolean;
  suppressedResult?: Record<string, unknown>;
  resultCount: number;
  /** Summed across every result, including turns replaced by a steer. */
  totalTokens: number;
  turnWaiters: Set<TurnWaiter>;
  writeLock: Promise<void>;
  completion: Promise<SubagentResult>;
  resolve: (result: SubagentResult) => void;
  pendingControls: Map<string, PendingControl>;
  abortController: AbortController;
  removeUpstreamAbort: () => void;
}

export interface ClaudeTurnOptions {
  prompt: string;
  parentAgentId: string;
  cwd: string;
  model?: string;
  mcpReminder?: string;
  signal?: AbortSignal;
  resumeSessionId?: string;
  sessionId?: string;
  onStarted?: (sessionId: string) => void;
}

export interface ClaudeMessageReceipt {
  mode: "steered" | "resumed";
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
}

const sessions = new Map<string, ClaudeSession>();
const CONTROL_RESPONSE_TIMEOUT_MS = 30_000;
const TURN_START_TIMEOUT_MS = 60_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function userInput(prompt: string): string {
  return `${JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: prompt }],
    },
  })}\n`;
}

function interruptInput(requestId: string): string {
  return `${JSON.stringify({
    type: "control_request",
    request_id: requestId,
    request: { subtype: "interrupt" },
  })}\n`;
}

const CLAUDE_WORKER_TOOLS = "Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch";

/** Orients a worker whose only reader is the orchestrating Letta agent. */
export const CLAUDE_WORKER_INSTRUCTIONS = `You are a coding worker launched by a Letta agent, not a human.
- No one can answer questions while you work. Resolve ambiguity with the most conservative reasonable choice, record it under assumptions, and continue. If you cannot proceed, stop and report status: blocked with the exact question.
- Act only within the scope the task grants. Do not commit, push, or open pull requests unless the task asks.
- A message that arrives while you work comes from the orchestrating agent and supersedes earlier instructions where they conflict. Keep finished work that still applies.
- Only your final message is returned, and it is cut off after ${LIMITS.TASK_OUTPUT_CHARS.toLocaleString("en-US")} characters. Skip progress narration and task recaps. End with:
status: done | partial | blocked
changes: one line per path
verification: command → result
assumptions / open issues: bullets, or none`;

/**
 * Scope a Claude Code worker to coding. `--allowed-tools` only pre-approves,
 * so `--tools` limits what loads; Skill stays so project skills keep working.
 * `--strict-mcp-config` drops the user's global MCP servers, which `--tools`
 * would otherwise inline as full schemas. Parent MCP servers stay reachable
 * through `letta mcp`. Project CLAUDE.md is still loaded.
 */
export function buildClaudeWorkerArgs(mcpReminder?: string): string[] {
  return [
    "--permission-mode",
    "acceptEdits",
    "--tools",
    `${CLAUDE_WORKER_TOOLS},Skill`,
    "--allowed-tools",
    CLAUDE_WORKER_TOOLS,
    "--strict-mcp-config",
    "--append-system-prompt",
    mcpReminder
      ? `${CLAUDE_WORKER_INSTRUCTIONS}\n\n${mcpReminder}`
      : CLAUDE_WORKER_INSTRUCTIONS,
  ];
}

export function buildClaudeStreamArgs(options: {
  model?: string;
  mcpReminder?: string;
  resumeSessionId?: string;
  sessionId?: string;
}): string[] {
  const args = [
    "--print",
    "--verbose",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    ...buildClaudeWorkerArgs(options.mcpReminder),
  ];
  if (options.model) args.push("--model", options.model);
  if (options.resumeSessionId) args.push("--resume", options.resumeSessionId);
  else if (options.sessionId) args.push("--session-id", options.sessionId);
  return args;
}

/** Anthropic reports input excluding cache reads and writes; sum all four. */
export function readClaudeUsageTokens(value: Record<string, unknown>): number {
  const usage = readRecord(value.usage);
  if (!usage) return 0;
  let total = 0;
  for (const key of [
    "input_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "output_tokens",
  ]) {
    const count = usage[key];
    if (typeof count === "number" && Number.isFinite(count)) total += count;
  }
  return total;
}

function createTransport(options: {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): RunningSubagentProcess {
  return spawnSubagentProcess("claude", options.args, options);
}

function tokenUsage(session: ClaudeSession): { totalTokens?: number } {
  return session.totalTokens > 0 ? { totalTokens: session.totalTokens } : {};
}

function successResult(session: ClaudeSession): SubagentResult {
  return {
    agentId: `claude_${session.sessionId}`,
    runtimeSessionId: session.sessionId,
    model: session.model,
    report: session.report,
    success: true,
    ...tokenUsage(session),
    durationMs: Date.now() - session.startedAt,
  };
}

function failResult(session: ClaudeSession, error: unknown): SubagentResult {
  return {
    agentId: `claude_${session.sessionId}`,
    runtimeSessionId: session.sessionId,
    model: session.model,
    report: session.report,
    success: false,
    error: errorMessage(error),
    ...tokenUsage(session),
    durationMs: Date.now() - session.startedAt,
  };
}

function rejectControls(session: ClaudeSession, error: Error): void {
  for (const pending of session.pendingControls.values()) pending.reject(error);
  session.pendingControls.clear();
}

function rejectTurnWaiters(session: ClaudeSession, error: Error): void {
  for (const waiter of session.turnWaiters) waiter.reject(error);
  session.turnWaiters.clear();
}

function markTurnStarted(session: ClaudeSession): void {
  session.interruptible = true;
  if (session.awaitingReplacementStart) {
    session.awaitingReplacementStart = false;
    session.pendingSteers = 0;
    session.suppressedResult = undefined;
  }
  for (const waiter of session.turnWaiters) waiter.resolve();
  session.turnWaiters.clear();
}

function waitForTurnStart(
  session: ClaudeSession,
  signal?: AbortSignal,
): Promise<void> {
  if (session.interruptible) return Promise.resolve();
  if (session.settled) {
    return Promise.reject(new Error("Claude Code session is no longer active"));
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve: finishResolve, reject: finishReject };
    const timeout = setTimeout(
      () => finishReject(new Error("Claude turn did not become interruptible")),
      TURN_START_TIMEOUT_MS,
    );
    timeout.unref?.();
    const abort = () =>
      finishReject(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error("Claude steering cancelled"),
      );
    function cleanup(): void {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      session.turnWaiters.delete(waiter);
    }
    function finishResolve(): void {
      cleanup();
      resolve();
    }
    function finishReject(error: Error): void {
      cleanup();
      reject(error);
    }
    session.turnWaiters.add(waiter);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function settle(session: ClaudeSession, result: SubagentResult): void {
  if (session.settled) return;
  session.settled = true;
  session.removeUpstreamAbort();
  if (sessions.get(session.sessionId) === session)
    sessions.delete(session.sessionId);
  const completedError = new Error("Claude Code session completed");
  rejectControls(session, completedError);
  rejectTurnWaiters(session, completedError);
  session.resolve(result);
}

function writeRaw(stdin: Writable, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (stdin.destroyed || stdin.writableEnded)
      return reject(new Error("Claude Code session stdin is closed"));
    stdin.write(data, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function writeInput(stdin: Writable, prompt: string): Promise<void> {
  return writeRaw(stdin, userInput(prompt));
}

function closeInput(session: ClaudeSession): void {
  if (
    !session.transport.process.stdin.destroyed &&
    !session.transport.process.stdin.writableEnded
  ) {
    session.transport.process.stdin.end();
  }
}

async function withWriteLock<T>(
  session: ClaudeSession,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = session.writeLock;
  let release!: () => void;
  session.writeLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function handleControlResponse(
  session: ClaudeSession,
  value: Record<string, unknown>,
): void {
  const response = readRecord(value.response);
  if (!response) return;
  const requestId = response.request_id;
  if (typeof requestId !== "string") return;
  const pending = session.pendingControls.get(requestId);
  if (!pending) return;
  session.pendingControls.delete(requestId);
  if (response.subtype === "success") pending.resolve();
  else {
    const detail =
      typeof response.error === "string"
        ? response.error
        : `Claude interrupt was rejected (${String(response.subtype ?? "unknown")})`;
    pending.reject(new Error(detail));
  }
}

function settleResult(
  session: ClaudeSession,
  value: Record<string, unknown>,
): void {
  if (typeof value.result === "string") session.report = value.result;
  closeInput(session);
  if (value.is_error === true) {
    settle(session, failResult(session, value.result ?? "Claude Code failed"));
  } else {
    settle(session, successResult(session));
  }
}

function handleResult(
  session: ClaudeSession,
  value: Record<string, unknown>,
): void {
  session.interruptible = false;
  session.resultCount++;
  session.totalTokens += readClaudeUsageTokens(value);
  if (session.pendingSteers > 0) {
    session.pendingSteers--;
    session.suppressedResult = value;
    return;
  }
  settleResult(session, value);
}

async function launchSession(
  options: ClaudeTurnOptions,
  deps: ClaudeSessionDependencies,
): Promise<ClaudeSession> {
  const sessionId =
    options.resumeSessionId ??
    options.sessionId ??
    deps.createSessionId?.() ??
    randomUUID();
  const env = {
    ...(deps.env ?? process.env),
    AGENT_ID: options.parentAgentId,
    LETTA_AGENT_ID: options.parentAgentId,
  };
  const abortController = new AbortController();
  const abortFromUpstream = () =>
    abortController.abort(
      options.signal?.reason ?? "Claude Code turn cancelled",
    );
  options.signal?.addEventListener("abort", abortFromUpstream, { once: true });
  if (options.signal?.aborted) abortFromUpstream();
  const removeUpstreamAbort = () =>
    options.signal?.removeEventListener("abort", abortFromUpstream);
  let transport: ClaudeSessionTransport;
  try {
    transport = (deps.createTransport ?? createTransport)({
      args: buildClaudeStreamArgs({
        model: options.model,
        mcpReminder: options.mcpReminder,
        resumeSessionId: options.resumeSessionId,
        sessionId,
      }),
      cwd: options.cwd,
      env,
      signal: abortController.signal,
    });
  } catch (error) {
    removeUpstreamAbort();
    throw new Error(`Failed to start Claude Code: ${errorMessage(error)}`);
  }
  let resolve!: (result: SubagentResult) => void;
  const completion = new Promise<SubagentResult>((done) => {
    resolve = done;
  });
  const session: ClaudeSession = {
    sessionId,
    transport,
    model: options.model,
    startedAt: Date.now(),
    stderr: "",
    report: "",
    protocolError: undefined,
    settled: false,
    pendingSteers: 0,
    interruptible: false,
    awaitingReplacementStart: false,
    suppressedResult: undefined,
    resultCount: 0,
    totalTokens: 0,
    turnWaiters: new Set(),
    writeLock: Promise.resolve(),
    completion,
    resolve,
    pendingControls: new Map(),
    abortController,
    removeUpstreamAbort,
  };
  sessions.set(sessionId, session);
  transport.process.stderr.setEncoding("utf8");
  transport.process.stderr.on("data", (chunk: string) => {
    session.stderr += chunk;
  });
  const stdout = createInterface({ input: transport.process.stdout });
  stdout.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value.type === "control_response") {
        handleControlResponse(session, value);
      } else if (value.type === "result") {
        handleResult(session, value);
      } else if (
        value.type === "stream_event" &&
        readRecord(value.event)?.type === "message_start"
      ) {
        markTurnStarted(session);
      }
    } catch (error) {
      session.protocolError ??= `${errorMessage(error)}: ${line.slice(0, 500)}`;
    }
  });
  transport.completion
    .then(({ exitCode, exitSignal }) => {
      if (session.settled) return;
      const detail = session.stderr.trim();
      const protocolDetail = session.protocolError
        ? `; protocol error: ${session.protocolError}`
        : "";
      const error = transport.wasAborted()
        ? (abortController.signal.reason ?? "Claude Code turn cancelled")
        : `Claude Code exited before a final result with ${exitCode ?? exitSignal ?? "unknown status"}${detail ? `: ${detail}` : ""}${protocolDetail}`;
      rejectControls(session, new Error(errorMessage(error)));
      settle(session, failResult(session, error));
    })
    .catch((error) => {
      rejectControls(session, new Error(errorMessage(error)));
      settle(session, failResult(session, error));
    });
  try {
    await writeInput(transport.process.stdin, options.prompt);
  } catch (error) {
    settle(session, failResult(session, error));
    abortController.abort(error);
    await transport.completion.catch(() => undefined);
    throw error;
  }
  options.onStarted?.(sessionId);
  return session;
}

async function startSession(
  options: ClaudeTurnOptions,
  deps: ClaudeSessionDependencies,
): Promise<ClaudeSession> {
  const key = options.resumeSessionId ?? options.sessionId;
  if (key) {
    const active = sessions.get(key);
    if (active && !active.settled) return active;
  }
  return launchSession(options, deps);
}

export async function runClaudeTurn(
  options: ClaudeTurnOptions,
  deps: ClaudeSessionDependencies = {},
): Promise<SubagentResult> {
  const sessionId =
    options.resumeSessionId ??
    options.sessionId ??
    deps.createSessionId?.() ??
    randomUUID();
  options.onStarted?.(sessionId);
  try {
    const session = await startSession(
      { ...options, sessionId, onStarted: undefined },
      deps,
    );
    return await session.completion;
  } catch (error) {
    return {
      agentId: `claude_${sessionId}`,
      runtimeSessionId: sessionId,
      model: options.model,
      report: "",
      success: false,
      error: errorMessage(error),
    };
  }
}

async function steerSession(
  session: ClaudeSession,
  prompt: string,
  signal?: AbortSignal,
): Promise<void> {
  await withWriteLock(session, async () => {
    signal?.throwIfAborted();
    await waitForTurnStart(session, signal);
    if (session.settled || sessions.get(session.sessionId) !== session) {
      throw new Error("Claude Code session is no longer active");
    }
    const requestId = randomUUID();
    const response = new Promise<void>((resolve, reject) => {
      session.pendingControls.set(requestId, { resolve, reject });
    });
    session.pendingSteers++;
    session.interruptible = false;
    const resultCount = session.resultCount;
    let interruptAcknowledged = false;
    const rejectOnAbort = () => {
      session.pendingControls
        .get(requestId)
        ?.reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error("Claude steering cancelled"),
        );
    };
    signal?.addEventListener("abort", rejectOnAbort, { once: true });
    const timeout = setTimeout(() => {
      session.pendingControls
        .get(requestId)
        ?.reject(new Error("Claude interrupt acknowledgement timed out"));
    }, CONTROL_RESPONSE_TIMEOUT_MS);
    timeout.unref?.();
    try {
      await writeRaw(
        session.transport.process.stdin,
        interruptInput(requestId),
      );
      await response;
      interruptAcknowledged = true;
      signal?.throwIfAborted();
      await writeInput(session.transport.process.stdin, prompt);
      session.awaitingReplacementStart = true;
      session.suppressedResult = undefined;
    } catch (error) {
      session.pendingSteers = Math.max(0, session.pendingSteers - 1);
      if (interruptAcknowledged) {
        session.abortController.abort(error);
        await session.transport.completion.catch(() => undefined);
      } else if (session.suppressedResult) {
        const suppressed = session.suppressedResult;
        session.suppressedResult = undefined;
        settleResult(session, suppressed);
      } else if (
        session.resultCount === resultCount &&
        !session.settled &&
        sessions.get(session.sessionId) === session
      ) {
        markTurnStarted(session);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", rejectOnAbort);
      session.pendingControls.delete(requestId);
    }
  });
}

export async function sendClaudeMessage(
  options: Omit<
    ClaudeTurnOptions,
    "resumeSessionId" | "sessionId" | "onStarted"
  > & {
    sessionId: string;
  },
  deps: ClaudeSessionDependencies = {},
): Promise<ClaudeMessageReceipt> {
  options.signal?.throwIfAborted();
  const active = sessions.get(options.sessionId);
  if (active && !active.settled) {
    try {
      await steerSession(active, options.prompt, options.signal);
      return { mode: "steered", sessionId: options.sessionId };
    } catch (error) {
      if (sessions.get(options.sessionId) === active && !active.settled)
        throw error;
      // Process completed while acquiring the write lock; resume exactly once below.
    }
  }
  const session = await startSession(
    { ...options, resumeSessionId: options.sessionId },
    deps,
  );
  if (session.sessionId !== options.sessionId) {
    throw new Error("Claude Code resumed with an unexpected session ID");
  }
  return {
    mode: "resumed",
    sessionId: options.sessionId,
    completion: session.completion,
    interrupt: async () => {
      session.abortController.abort(new Error("Claude Code turn cancelled"));
    },
  };
}

export function hasActiveClaudeTurn(sessionId: string): boolean {
  return Boolean(sessions.get(sessionId) && !sessions.get(sessionId)?.settled);
}

export function __resetClaudeSessionsForTests(): void {
  for (const session of sessions.values())
    session.abortController.abort(new Error("Test reset"));
  sessions.clear();
}
