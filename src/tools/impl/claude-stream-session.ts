import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Writable } from "node:stream";
import type { SubagentResult } from "@/agent/subagents";
import {
  type RunningSubagentProcess,
  spawnManagedWorkloadProcess,
} from "@/agent/subagents/subagent-process";
import { withNativeCliPath } from "@/utils/native-cli-env";
import {
  type ExternalToolCallListener,
  formatExternalToolCallArgs,
} from "./external-tool-call";

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
  /** True once the transport's process has exited. */
  exited: boolean;
  /** Resolves when the transport's process has exited. */
  exit: Promise<void>;
  /** UUID of the most recent user input written to stdin. */
  latestInputUuid?: string;
  /** True once Claude has picked up {@link latestInputUuid}. */
  latestInputStarted: boolean;
  /** True once Claude has acknowledged any of our inputs by UUID. */
  acknowledgesInputs: boolean;
  pendingSteers: number;
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
  /** Called once per `tool_use` block the worker emits. */
  onToolCall?: ExternalToolCallListener;
  beforeStart?: () => Promise<void>;
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
  /** Override for {@link BACKGROUND_TASK_WAIT_CAP_MS} (tests). */
  backgroundTaskWaitCapMs?: number;
  /** Override for {@link SETTLED_EXIT_GRACE_MS} (tests). */
  settledExitGraceMs?: number;
}

const sessions = new Map<string, ClaudeSession>();
const CONTROL_RESPONSE_TIMEOUT_MS = 30_000;
const TURN_START_TIMEOUT_MS = 60_000;
/**
 * How long to keep waiting after a result while background tasks are still
 * listed. Claude Code's own background-task limit is 30 minutes.
 */
export const BACKGROUND_TASK_WAIT_CAP_MS = 35 * 60_000;
/**
 * How long a new turn waits for a settled session's process to exit on its
 * own before stopping it. Its stdin is already closed, so it cannot take the
 * turn, and a second process must not run on the same session ID.
 */
export const SETTLED_EXIT_GRACE_MS = 10_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function userInput(prompt: string, uuid: string): string {
  return `${JSON.stringify({
    type: "user",
    uuid,
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
    // Echo each input back once Claude picks it up, so results can be matched
    // to the input they answer.
    "--replay-user-messages",
    // Subagents run unattended and nothing relays Claude Code permission
    // prompts back to the parent, so a gated tool call can only stall.
    "--permission-mode",
    "bypassPermissions",
  ];
  if (options.model) args.push("--model", options.model);
  if (options.resumeSessionId) args.push("--resume", options.resumeSessionId);
  else if (options.sessionId) args.push("--session-id", options.sessionId);
  if (options.mcpReminder)
    args.push("--append-system-prompt", options.mcpReminder);
  return args;
}

function createTransport(options: {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): RunningSubagentProcess {
  return spawnManagedWorkloadProcess("claude", options.args, options);
}

function successResult(session: ClaudeSession): SubagentResult {
  return {
    agentId: `claude_${session.sessionId}`,
    runtimeSessionId: session.sessionId,
    model: session.model,
    report: session.report,
    success: true,
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

function clearBackgroundCap(session: ClaudeSession): void {
  if (session.backgroundCapTimer) clearTimeout(session.backgroundCapTimer);
  session.backgroundCapTimer = undefined;
}

function markTurnStarted(session: ClaudeSession): void {
  session.interruptible = true;
  session.idleOnBackgroundTasks = false;
  clearBackgroundCap(session);
  if (session.awaitingReplacementStart) {
    session.awaitingReplacementStart = false;
    session.pendingSteers = 0;
    session.suppressedResult = undefined;
  }
  resolveTurnWaiters(session);
}

function resolveTurnWaiters(session: ClaudeSession): void {
  for (const waiter of session.turnWaiters) waiter.resolve();
  session.turnWaiters.clear();
}

/** Resolves once a turn can be interrupted or Claude is idle on background tasks. */
function waitForTurnStart(
  session: ClaudeSession,
  signal?: AbortSignal,
): Promise<void> {
  if (session.interruptible || session.idleOnBackgroundTasks)
    return Promise.resolve();
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

/**
 * Resolves the turn's result. The session stays registered, and cancellation
 * still reaches its process, until that process exits.
 */
function settle(session: ClaudeSession, result: SubagentResult): void {
  if (session.settled) return;
  session.settled = true;
  session.idleOnBackgroundTasks = false;
  clearBackgroundCap(session);
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

/** Writes a user turn and records it as the input the next result must answer. */
function writeInput(session: ClaudeSession, prompt: string): Promise<void> {
  const uuid = randomUUID();
  session.latestInputUuid = uuid;
  session.latestInputStarted = false;
  return writeRaw(session.transport.process.stdin, userInput(prompt, uuid));
}

/** Marks an input as picked up when Claude echoes or starts it by UUID. */
function acknowledgeInput(session: ClaudeSession, uuid: unknown): void {
  if (typeof uuid !== "string" || !session.latestInputUuid) return;
  session.acknowledgesInputs = true;
  if (uuid === session.latestInputUuid) session.latestInputStarted = true;
}

/**
 * True for a result that cannot answer our latest input because Claude has
 * not picked that input up yet, e.g. a turn Claude started itself after a
 * background task finished. Claude versions that never acknowledge inputs
 * fall back to treating every result as current.
 */
function isStaleResult(session: ClaudeSession): boolean {
  return session.acknowledgesInputs && !session.latestInputStarted;
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

/** Emit each `tool_use` block of a stream-json `assistant` message once. */
function handleAssistant(
  session: ClaudeSession,
  value: Record<string, unknown>,
): void {
  if (!session.onToolCall) return;
  const content = readRecord(value.message)?.content;
  if (!Array.isArray(content)) return;
  for (const entry of content) {
    const block = readRecord(entry);
    if (
      block?.type !== "tool_use" ||
      typeof block.id !== "string" ||
      typeof block.name !== "string" ||
      session.seenToolCallIds.has(block.id)
    )
      continue;
    session.seenToolCallIds.add(block.id);
    try {
      session.onToolCall({
        id: block.id,
        name: block.name,
        args: formatExternalToolCallArgs(block.input),
      });
    } catch {
      // Progress display must not break the session.
    }
  }
}

function settleResult(
  session: ClaudeSession,
  value: Record<string, unknown>,
): void {
  // The session stays registered until its process exits, so a result line
  // can still arrive after settle; it must not rewrite the finished report.
  if (session.settled) return;
  if (typeof value.result === "string") session.report = value.result;
  closeInput(session);
  if (value.is_error === true) {
    settle(session, failResult(session, value.result ?? "Claude Code failed"));
  } else {
    settle(session, successResult(session));
  }
}

function handleBackgroundTasksChanged(
  session: ClaudeSession,
  value: Record<string, unknown>,
): void {
  if (Array.isArray(value.tasks)) session.backgroundTasks = value.tasks;
}

/**
 * Claude ended its turn while background tasks are still running, so it will
 * wake itself up for another turn once they finish. Keep the result as the
 * provisional report and keep reading instead of settling.
 */
function holdResult(
  session: ClaudeSession,
  value: Record<string, unknown>,
): void {
  // A result flushed after settle (around exit, or via a steer fallback) must
  // not re-arm the cap or mutate a finished session.
  if (session.settled) return;
  const capMs = session.backgroundCapMs;
  if (typeof value.result === "string") session.report = value.result;
  session.provisionalResult = value;
  session.idleOnBackgroundTasks = true;
  resolveTurnWaiters(session);
  clearBackgroundCap(session);
  session.backgroundCapTimer = setTimeout(() => {
    session.backgroundCapTimer = undefined;
    if (session.settled) return;
    const minutes = Math.round(capMs / 60_000);
    const note = `[Claude Code background tasks were still running ${minutes} minute(s) after its last result; reporting that result.]`;
    const text =
      typeof value.result === "string" ? value.result : session.report;
    // Same settle path as a final result, so an errored turn reports as failed.
    settleResult(session, {
      ...value,
      result: text ? `${text}\n\n${note}` : note,
    });
  }, capMs);
  // Deliberately not unref'd: a held session always has a live child process,
  // so unref saves nothing, and an unref'd timer is not guaranteed to fire
  // (observed on Windows), which would leave the session unsettled forever.
  // settle() and the next turn start clear it, so it never outlives the session.
}

/** Settle on a final result unless Claude is still waiting on background tasks. */
function finishResult(
  session: ClaudeSession,
  value: Record<string, unknown>,
): void {
  if (session.backgroundTasks.length > 0) holdResult(session, value);
  else settleResult(session, value);
}

function handleResult(
  session: ClaudeSession,
  value: Record<string, unknown>,
): void {
  session.interruptible = false;
  session.resultCount++;
  if (session.pendingSteers > 0) {
    session.pendingSteers--;
    session.suppressedResult = value;
    return;
  }
  if (isStaleResult(session)) return;
  finishResult(session, value);
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
  const env = withNativeCliPath({
    ...(deps.env ?? process.env),
    AGENT_ID: options.parentAgentId,
    LETTA_AGENT_ID: options.parentAgentId,
    // Claude Code refuses bypassPermissions as root unless told it is sandboxed.
    IS_SANDBOX: "1",
  });
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
  let resolveExit!: () => void;
  const exit = new Promise<void>((done) => {
    resolveExit = done;
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
    exited: false,
    exit,
    latestInputUuid: undefined,
    latestInputStarted: false,
    acknowledgesInputs: false,
    pendingSteers: 0,
    interruptible: false,
    awaitingReplacementStart: false,
    suppressedResult: undefined,
    resultCount: 0,
    backgroundTasks: [],
    provisionalResult: undefined,
    idleOnBackgroundTasks: false,
    backgroundCapMs:
      deps.backgroundTaskWaitCapMs ?? BACKGROUND_TASK_WAIT_CAP_MS,
    backgroundCapTimer: undefined,
    turnWaiters: new Set(),
    writeLock: Promise.resolve(),
    completion,
    resolve,
    pendingControls: new Map(),
    abortController,
    removeUpstreamAbort,
    onToolCall: options.onToolCall,
    seenToolCallIds: new Set(),
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
      } else if (value.type === "user" && value.isReplay === true) {
        acknowledgeInput(session, value.uuid);
      } else if (
        value.type === "command_lifecycle" &&
        (value.state === "started" || value.state === "completed")
      ) {
        acknowledgeInput(session, value.command_uuid);
      } else if (value.type === "result") {
        handleResult(session, value);
      } else if (
        value.type === "system" &&
        value.subtype === "background_tasks_changed"
      ) {
        handleBackgroundTasksChanged(session, value);
      } else if (value.type === "assistant") {
        handleAssistant(session, value);
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
      if (
        session.provisionalResult &&
        exitCode === 0 &&
        !transport.wasAborted()
      ) {
        settleResult(session, session.provisionalResult);
        return;
      }
      const detail = session.stderr.trim();
      const protocolDetail = session.protocolError
        ? `; protocol error: ${session.protocolError}`
        : "";
      const oomDetail =
        exitCode === 143 || exitSignal === "SIGTERM" || exitSignal === "SIGKILL"
          ? "; possibly out of memory"
          : "";
      const error = transport.wasAborted()
        ? (abortController.signal.reason ?? "Claude Code turn cancelled")
        : `Claude Code exited before a final result with ${exitCode ?? exitSignal ?? "unknown status"}${oomDetail}${detail ? `: ${detail}` : ""}${protocolDetail}`;
      rejectControls(session, new Error(errorMessage(error)));
      settle(session, failResult(session, error));
    })
    .catch((error) => {
      rejectControls(session, new Error(errorMessage(error)));
      settle(session, failResult(session, error));
    })
    .finally(() => {
      session.exited = true;
      removeUpstreamAbort();
      if (sessions.get(sessionId) === session) sessions.delete(sessionId);
      resolveExit();
    });
  try {
    await writeInput(session, options.prompt);
  } catch (error) {
    settle(session, failResult(session, error));
    abortController.abort(error);
    await transport.completion.catch(() => undefined);
    throw error;
  }
  options.onStarted?.(sessionId);
  return session;
}

/**
 * Waits for a settled session's process to exit, stopping it after a grace
 * period. Its stdin is closed, so it can't take another turn, and starting a
 * second `claude --resume` beside it would run two processes on one session.
 */
async function waitForSettledExit(
  session: ClaudeSession,
  deps: ClaudeSessionDependencies,
  signal?: AbortSignal,
): Promise<void> {
  if (session.exited) return;
  const graceMs = deps.settledExitGraceMs ?? SETTLED_EXIT_GRACE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () =>
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error("Claude Code turn cancelled"),
      );
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  cancelled.catch(() => undefined);
  try {
    const exitedInTime = await Promise.race([
      session.exit.then(() => true),
      new Promise<boolean>((resolve) => {
        // Not unref'd: the caller is awaiting this, and an unref'd timer is
        // not guaranteed to fire (observed on Windows). Cleared below.
        timer = setTimeout(() => resolve(false), graceMs);
      }),
      cancelled,
    ]);
    if (!exitedInTime) {
      session.abortController.abort(
        new Error("Claude Code process replaced by a new turn"),
      );
      await Promise.race([session.exit, cancelled]);
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

async function startSession(
  options: ClaudeTurnOptions,
  deps: ClaudeSessionDependencies,
): Promise<ClaudeSession> {
  const key = options.resumeSessionId ?? options.sessionId;
  if (key) {
    for (;;) {
      const existing = sessions.get(key);
      if (!existing) break;
      if (!existing.settled) return existing;
      await waitForSettledExit(existing, deps, options.signal);
    }
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
    if (session.idleOnBackgroundTasks) {
      // No turn is running to interrupt: Claude is idle until its background
      // tasks finish, so the message simply starts the next turn.
      if (session.settled || sessions.get(session.sessionId) !== session) {
        throw new Error("Claude Code session is no longer active");
      }
      session.idleOnBackgroundTasks = false;
      await writeInput(session, prompt);
      return;
    }
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
      await writeInput(session, prompt);
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
        finishResult(session, suppressed);
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

/**
 * Steers the live process for this session, waiting out a settled one that
 * hasn't exited yet. With no process left, calls `launch` in the same
 * continuation so concurrent senders can't both start a `claude --resume`.
 */
async function deliverClaudeMessage(
  options: { sessionId: string; prompt: string; signal?: AbortSignal },
  deps: ClaudeSessionDependencies,
  launch?: () => Promise<ClaudeSession>,
): Promise<
  { mode: "steered" | "resumed"; session: ClaudeSession } | undefined
> {
  for (;;) {
    const existing = sessions.get(options.sessionId);
    if (!existing) break;
    if (existing.settled) {
      await waitForSettledExit(existing, deps, options.signal);
      continue;
    }
    try {
      await steerSession(existing, options.prompt, options.signal);
      return { mode: "steered", session: existing };
    } catch (error) {
      if (sessions.get(options.sessionId) === existing && !existing.settled)
        throw error;
      // Settled while acquiring the write lock; wait for its exit, then retry.
    }
  }
  if (!launch) return undefined;
  const session = await launch();
  if (session.sessionId !== options.sessionId) {
    throw new Error("Claude Code resumed with an unexpected session ID");
  }
  return { mode: "resumed", session };
}

function trackedReceipt(session: ClaudeSession): ClaudeMessageReceipt {
  return {
    mode: "resumed",
    sessionId: session.sessionId,
    completion: session.completion,
    interrupt: async () => {
      session.abortController.abort(new Error("Claude Code turn cancelled"));
    },
  };
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
  const steered = await deliverClaudeMessage(options, deps);
  if (steered) return { mode: "steered", sessionId: options.sessionId };
  if (options.beforeStart) await options.beforeStart();
  // Another send may have started a process while beforeStart ran. If so,
  // steer it, but still hand back its completion so the caller can release
  // whatever beforeStart reserved.
  const delivered = await deliverClaudeMessage(options, deps, () =>
    launchSession({ ...options, resumeSessionId: options.sessionId }, deps),
  );
  if (!delivered) throw new Error("Claude Code session did not start");
  if (delivered.mode === "steered" && !options.beforeStart)
    return { mode: "steered", sessionId: options.sessionId };
  return trackedReceipt(delivered.session);
}

export function hasActiveClaudeTurn(sessionId: string): boolean {
  return Boolean(sessions.get(sessionId) && !sessions.get(sessionId)?.settled);
}

export function __resetClaudeSessionsForTests(): void {
  for (const session of sessions.values())
    session.abortController.abort(new Error("Test reset"));
  sessions.clear();
}
