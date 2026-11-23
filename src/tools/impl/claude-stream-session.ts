import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Writable } from "node:stream";
import type { SubagentResult } from "@/agent/subagents";
import {
  type RunningSubagentProcess,
  spawnManagedWorkloadProcess,
} from "@/agent/subagents/subagent-process";
import { cloudRepositoryRoots } from "@/utils/cloud-repository-roots";
import { confirmProcessExit } from "@/utils/confirm-process-exit";
import { withNativeCliPath } from "@/utils/native-cli-env";
import { stageClaudeRepositorySkills } from "./claude-repository-skills";
import {
  CLAUDE_CONTROL_RESPONSE_TIMEOUT_MS,
  CLAUDE_INTERRUPT_ACK_TIMEOUT_ERROR,
  CLAUDE_TURN_START_TIMEOUT_ERROR,
  CLAUDE_TURN_START_TIMEOUT_MS,
} from "./claude-steer-timeouts";
import type {
  ClaudeMessageReceipt,
  ClaudeSession,
  ClaudeSessionDependencies,
  ClaudeSessionTransport,
  ClaudeTurnOptions,
} from "./claude-stream-session-types";
import { traceClaudeLaunch } from "./external-llm-trace-launch";
import {
  emitProgress,
  formatExternalToolCallArgs,
  toolOutputText,
} from "./external-tool-call";

export type {
  ClaudeMessageReceipt,
  ClaudeSessionDependencies,
  ClaudeSessionTransport,
  ClaudeTurnOptions,
} from "./claude-stream-session-types";

const sessions = new Map<string, ClaudeSession>();
const pendingResumes = new Map<string, Promise<ClaudeSession>>();
export const BACKGROUND_TASK_WAIT_CAP_MS = 35 * 60_000;
export const SETTLED_EXIT_GRACE_MS = 10_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function buildClaudeStreamArgs(options: {
  model?: string;
  mcpReminder?: string;
  resumeSessionId?: string;
  sessionId?: string;
  sessionName?: string;
  skillDirectories?: string[];
}): string[] {
  const args = [
    "--print",
    "--verbose",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--replay-user-messages",
    "--permission-mode",
    "bypassPermissions",
  ];
  if (options.model) args.push("--model", options.model);
  if (options.resumeSessionId) args.push("--resume", options.resumeSessionId);
  else if (options.sessionId) args.push("--session-id", options.sessionId);
  if (options.sessionName && !options.resumeSessionId)
    args.push("--name", options.sessionName);
  if (options.mcpReminder)
    args.push("--append-system-prompt", options.mcpReminder);
  if (options.skillDirectories?.length)
    args.push("--add-dir", ...options.skillDirectories);
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
    session.queuedSteer = false;
    session.suppressedResult = undefined;
  }
  resolveTurnWaiters(session);
}

function resolveTurnWaiters(session: ClaudeSession): void {
  for (const waiter of session.turnWaiters) waiter.resolve();
  session.turnWaiters.clear();
}

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
      () => finishReject(new Error(CLAUDE_TURN_START_TIMEOUT_ERROR)),
      CLAUDE_TURN_START_TIMEOUT_MS,
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

function writeInput(session: ClaudeSession, prompt: string): Promise<void> {
  const uuid = randomUUID();
  session.latestInputUuid = uuid;
  session.latestInputStarted = false;
  return writeRaw(
    session.transport.process.stdin,
    `${JSON.stringify({ type: "user", uuid, message: { role: "user", content: [{ type: "text", text: prompt }] } })}\n`,
  );
}

function acknowledgeInput(session: ClaudeSession, uuid: unknown): void {
  if (typeof uuid !== "string" || !session.latestInputUuid) return;
  session.acknowledgesInputs = true;
  if (uuid === session.latestInputUuid) session.latestInputStarted = true;
}

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

function reportText(
  session: ClaudeSession,
  messageId: unknown,
  text: unknown,
): void {
  if (!session.onText || typeof text !== "string" || !text.trim()) return;
  const key = `${typeof messageId === "string" ? messageId : ""}\u0000${text.slice(0, 1_000)}`;
  if (session.seenTextBlocks.has(key)) return;
  session.seenTextBlocks.add(key);
  emitProgress(session.onText, text);
}

function handleAssistant(
  session: ClaudeSession,
  value: Record<string, unknown>,
): void {
  const message = readRecord(value.message);
  const content = message?.content;
  if (!Array.isArray(content)) return;
  for (const entry of content) {
    const block = readRecord(entry);
    if (block?.type === "text") {
      reportText(session, message?.id, block.text);
      continue;
    }
    if (block?.type === "thinking" && typeof block.thinking === "string") {
      if (block.thinking.trim())
        emitProgress(session.onReasoning, block.thinking);
      continue;
    }
    if (
      block?.type !== "tool_use" ||
      typeof block.id !== "string" ||
      typeof block.name !== "string" ||
      session.seenToolCallIds.has(block.id)
    )
      continue;
    session.seenToolCallIds.add(block.id);
    session.toolNames.set(block.id, block.name);
    emitProgress(session.onToolCall, {
      id: block.id,
      name: block.name,
      args: formatExternalToolCallArgs(block.input),
      input: block.input,
    });
  }
}

function handleToolResults(
  session: ClaudeSession,
  value: Record<string, unknown>,
): void {
  const content = readRecord(value.message)?.content;
  if (!Array.isArray(content)) return;
  for (const entry of content) {
    const block = readRecord(entry);
    const id = block?.tool_use_id;
    if (block?.type !== "tool_result" || typeof id !== "string") continue;
    const name = session.toolNames.get(id);
    if (!session.toolNames.delete(id)) continue;
    emitProgress(session.onToolResult, {
      id,
      name,
      isError: block.is_error === true,
      output: toolOutputText(block.content),
    });
  }
}

function settleResult(
  session: ClaudeSession,
  value: Record<string, unknown>,
): void {
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

function holdResult(
  session: ClaudeSession,
  value: Record<string, unknown>,
): void {
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
    settleResult(session, {
      ...value,
      result: text ? `${text}\n\n${note}` : note,
    });
  }, capMs);
}

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
  if (
    session.queuedSteer &&
    session.acknowledgesInputs &&
    session.latestInputStarted
  ) {
    session.pendingSteers = 0;
    session.queuedSteer = false;
  } else if (session.pendingSteers > 0) {
    session.pendingSteers--;
    if (session.pendingSteers === 0) session.queuedSteer = false;
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
  const trace = deps.createTransport
    ? undefined
    : await traceClaudeLaunch(options.traceContext, env, sessionId);
  let skills:
    | Awaited<ReturnType<typeof stageClaudeRepositorySkills>>
    | undefined;
  let transport: ClaudeSessionTransport;
  try {
    skills = await stageClaudeRepositorySkills(
      cloudRepositoryRoots(options.cloudSkillRepositories),
    );
    transport = (deps.createTransport ?? createTransport)({
      args: buildClaudeStreamArgs({
        model: options.model,
        mcpReminder: options.mcpReminder,
        resumeSessionId: options.resumeSessionId,
        sessionId,
        sessionName: options.sessionName,
        skillDirectories: skills.directories,
      }),
      cwd: options.cwd,
      env,
      signal: abortController.signal,
    });
  } catch (error) {
    void trace?.close();
    await skills?.cleanup().catch(() => undefined);
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
    queuedSteer: false,
    interruptible: false,
    awaitingReplacementStart: false,
    suppressedResult: undefined,
    resultCount: 0,
    backgroundTasks: [],
    provisionalResult: undefined,
    idleOnBackgroundTasks: false,
    backgroundCapMs:
      deps.backgroundTaskWaitCapMs ?? BACKGROUND_TASK_WAIT_CAP_MS,
    controlResponseTimeoutMs:
      deps.controlResponseTimeoutMs ?? CLAUDE_CONTROL_RESPONSE_TIMEOUT_MS,
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
    onText: options.onText,
    seenTextBlocks: new Set(),
    onToolResult: options.onToolResult,
    onReasoning: options.onReasoning,
    toolNames: new Map(),
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
      } else if (value.type === "user") {
        handleToolResults(session, value);
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
  void transport.completion
    .finally(() => Promise.allSettled([trace?.close(), skills?.cleanup()]))
    .catch(() => undefined);
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
): Promise<"steered" | "queued"> {
  return withWriteLock(session, async () => {
    signal?.throwIfAborted();
    await waitForTurnStart(session, signal);
    if (session.idleOnBackgroundTasks) {
      if (session.settled || sessions.get(session.sessionId) !== session) {
        throw new Error("Claude Code session is no longer active");
      }
      session.idleOnBackgroundTasks = false;
      await writeInput(session, prompt);
      return "steered";
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
    let ackTimedOut = false;
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
      const pending = session.pendingControls.get(requestId);
      ackTimedOut = Boolean(pending);
      pending?.reject(new Error(CLAUDE_INTERRUPT_ACK_TIMEOUT_ERROR));
    }, session.controlResponseTimeoutMs);
    timeout.unref?.();
    try {
      await writeRaw(
        session.transport.process.stdin,
        `${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } })}\n`,
      );
      await response;
      interruptAcknowledged = true;
      signal?.throwIfAborted();
      await writeInput(session, prompt);
      session.awaitingReplacementStart = true;
      session.suppressedResult = undefined;
      return "steered";
    } catch (error) {
      if (
        ackTimedOut &&
        !signal?.aborted &&
        !session.settled &&
        sessions.get(session.sessionId) === session &&
        (await queueSteerPrompt(session, prompt))
      )
        return "queued";
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

async function queueSteerPrompt(
  session: ClaudeSession,
  prompt: string,
): Promise<boolean> {
  try {
    await writeInput(session, prompt);
  } catch {
    return false;
  }
  session.suppressedResult = undefined;
  session.awaitingReplacementStart = false;
  session.queuedSteer = session.pendingSteers > 0;
  return true;
}

async function deliverClaudeMessage(
  options: { sessionId: string; prompt: string; signal?: AbortSignal },
  deps: ClaudeSessionDependencies,
  launch?: () => Promise<ClaudeSession>,
): Promise<
  | { mode: "steered" | "resumed"; queued?: boolean; session: ClaudeSession }
  | undefined
> {
  for (;;) {
    options.signal?.throwIfAborted();
    const pending = pendingResumes.get(options.sessionId);
    if (pending) {
      await pending;
      continue;
    }
    const existing = sessions.get(options.sessionId);
    if (!existing) break;
    if (existing.settled) {
      await waitForSettledExit(existing, deps, options.signal);
      continue;
    }
    try {
      const delivery = await steerSession(
        existing,
        options.prompt,
        options.signal,
      );
      return {
        mode: "steered",
        queued: delivery === "queued",
        session: existing,
      };
    } catch (error) {
      if (sessions.get(options.sessionId) === existing && !existing.settled)
        throw error;
    }
  }
  if (!launch) return undefined;
  const pending = launch().finally(() =>
    pendingResumes.delete(options.sessionId),
  );
  pendingResumes.set(options.sessionId, pending);
  const session = await pending;
  if (session.sessionId !== options.sessionId) {
    throw new Error("Claude Code resumed with an unexpected session ID");
  }
  return { mode: "resumed", session };
}

function steeredReceipt(
  sessionId: string,
  queued?: boolean,
): ClaudeMessageReceipt {
  return { mode: "steered", sessionId, ...(queued ? { queued: true } : {}) };
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
  if (steered) return steeredReceipt(options.sessionId, steered.queued);
  if (options.beforeStart) await options.beforeStart();
  const delivered = await deliverClaudeMessage(options, deps, () =>
    launchSession({ ...options, resumeSessionId: options.sessionId }, deps),
  );
  if (!delivered) throw new Error("Claude Code session did not start");
  if (delivered.mode === "steered" && !options.beforeStart)
    return steeredReceipt(options.sessionId, delivered.queued);
  return trackedReceipt(delivered.session);
}
export async function stopClaudeSession(sessionId: string): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (!session) return false;
  session.abortController.abort(new Error("Stopped by parent"));
  await confirmProcessExit(session.exit, "Claude Code");
  return true;
}

export function hasActiveClaudeTurn(sessionId: string): boolean {
  return Boolean(sessions.get(sessionId) && !sessions.get(sessionId)?.settled);
}

export function __resetClaudeSessionsForTests(): void {
  for (const session of sessions.values())
    session.abortController.abort(new Error("Test reset"));
  sessions.clear();
}
