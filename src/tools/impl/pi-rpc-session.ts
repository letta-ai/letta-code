/**
 * Runs the pi coding agent (`pi --mode rpc`) as an external coding worker.
 *
 * pi speaks strict JSONL over stdio: commands on stdin, `response` records and
 * session events on stdout. One long-lived process serves one session; a turn
 * ends at `agent_settled`, after pi's own retries, compaction recovery and
 * queued steering have finished.
 */
import { randomUUID } from "node:crypto";
import type { SubagentResult } from "@/agent/subagents";
import {
  type RunningSubagentProcess,
  spawnManagedWorkloadProcess,
} from "@/agent/subagents/subagent-process";
import {
  type ExternalWorkerListeners,
  emitProgress,
  formatExternalToolCallArgs,
  toolOutputText,
} from "./external-tool-call";
import { findPiSessionPath } from "./pi-session-paths";

export const PI_NOT_SIGNED_IN_PREFIX = "pi is not signed in:";
const IDLE_TIMEOUT_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** pi extension UI methods that block until the client answers. */
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export interface PiTurnOptions extends ExternalWorkerListeners {
  prompt: string;
  parentAgentId: string;
  cwd: string;
  model?: string;
  mcpReminder?: string;
  signal?: AbortSignal;
  /** Resume this existing pi session instead of starting a new one. */
  resumeSessionId?: string;
  /** Runs once the session ID is known, before the prompt is sent. */
  beforeStart?: (sessionId: string) => Promise<void>;
  onStarted?: (sessionId: string) => void;
}

export interface PiMessageReceipt {
  mode: "steered" | "new_turn";
  completion?: Promise<SubagentResult>;
  interrupt?: () => Promise<void>;
}

type PiRecord = Record<string, unknown>;

interface Turn {
  resolve: (result: SubagentResult) => void;
  completion: Promise<SubagentResult>;
  startedAt: number;
  listeners: ExternalWorkerListeners;
  seenToolCalls: Set<string>;
  lastText?: string;
  lastError?: string;
  model?: string;
  totalTokens: number;
}

interface Session {
  key: string;
  id: string;
  process: RunningSubagentProcess;
  lifetime: AbortController;
  pending: Map<string, (record: PiRecord) => void>;
  stderr: string;
  active?: Turn;
  lock: Promise<void>;
  idleTimer?: ReturnType<typeof setTimeout>;
  stopping?: Promise<void>;
}

const sessions = new Map<string, Session>();
const creations = new Map<string, Promise<Session>>();

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): PiRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as PiRecord)
    : undefined;
}

function sessionKey(parentAgentId: string, sessionId: string): string {
  if (!UUID.test(sessionId)) throw new Error("Invalid pi session ID");
  return `${parentAgentId}/${sessionId}`;
}

function withLock<T>(session: Session, work: () => Promise<T>): Promise<T> {
  const result = session.lock.then(work);
  session.lock = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function write(session: Session, command: PiRecord): void {
  session.process.process.stdin.write(`${JSON.stringify(command)}\n`);
}

/** Send a command and wait for its correlated `response` record. */
function request(session: Session, command: PiRecord): Promise<PiRecord> {
  if (session.stopping)
    return Promise.reject(new Error("pi session is stopping"));
  const id = randomUUID();
  return new Promise<PiRecord>((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pending.delete(id);
      reject(new Error(`pi did not answer ${String(command.type)}`));
    }, REQUEST_TIMEOUT_MS);
    session.pending.set(id, (record) => {
      clearTimeout(timer);
      if (record.success === true) resolve(asRecord(record.data) ?? {});
      else
        reject(
          new Error(
            typeof record.error === "string"
              ? record.error
              : `pi rejected ${String(command.type)}`,
          ),
        );
    });
    try {
      write(session, { ...command, id });
    } catch (error) {
      clearTimeout(timer);
      session.pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function finish(
  session: Session,
  turn: Turn,
  result: Pick<SubagentResult, "success" | "report" | "error">,
): void {
  if (session.active !== turn) return;
  session.active = undefined;
  if (!session.stopping) {
    session.idleTimer = setTimeout(
      () => void dispose(session),
      IDLE_TIMEOUT_MS,
    );
    session.idleTimer.unref?.();
  }
  turn.resolve({
    agentId: `pi_${session.id}`,
    runtimeSessionId: session.id,
    model: turn.model,
    durationMs: Date.now() - turn.startedAt,
    ...(turn.totalTokens > 0 ? { totalTokens: turn.totalTokens } : {}),
    ...result,
  });
}

function dispose(session: Session, error?: string): Promise<void> {
  if (session.stopping) return session.stopping;
  clearTimeout(session.idleTimer);
  if (sessions.get(session.key) === session) sessions.delete(session.key);
  const child = session.process.process;
  session.stopping = (async () => {
    // Closing stdin asks pi to dispose its runtime; the lifetime signal kills
    // the process group if it does not exit promptly.
    try {
      child.stdin.end();
    } catch {}
    const exited = await Promise.race([
      session.process.completion.then(() => true),
      new Promise<false>((resolve) =>
        setTimeout(() => resolve(false), 2_000).unref?.(),
      ),
    ]);
    if (!exited) session.lifetime.abort();
    await session.process.completion;
    for (const resolve of session.pending.values())
      resolve({ success: false, error: error ?? "pi session stopped" });
    session.pending.clear();
    if (session.active)
      finish(session, session.active, {
        success: false,
        report: "",
        error: error ?? "pi session stopped",
      });
  })();
  return session.stopping;
}

function assistantText(content: unknown): string {
  if (!Array.isArray(content))
    return typeof content === "string" ? content : "";
  return content
    .map((part) => {
      const block = asRecord(part);
      return block?.type === "text" && typeof block.text === "string"
        ? block.text
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

function onEvent(session: Session, record: PiRecord): void {
  if (record.type === "response") {
    const id = typeof record.id === "string" ? record.id : undefined;
    const pending = id ? session.pending.get(id) : undefined;
    if (id && pending) {
      session.pending.delete(id);
      pending(record);
    }
    return;
  }
  if (record.type === "extension_ui_request") {
    const method = typeof record.method === "string" ? record.method : "";
    if (!DIALOG_METHODS.has(method)) return;
    // Never answer a dialog on the user's behalf or leave pi waiting on one.
    try {
      write(session, {
        type: "extension_ui_response",
        id: record.id,
        cancelled: true,
      });
    } catch {}
    const title = typeof record.title === "string" ? `: ${record.title}` : "";
    void dispose(
      session,
      `pi requires interactive input (${method}${title}); continue in pi or disable that extension for this task`,
    );
    return;
  }
  const turn = session.active;
  if (!turn) return;
  const { onToolCall, onToolResult, onText, onReasoning } = turn.listeners;
  switch (record.type) {
    case "tool_execution_start": {
      const id = String(record.toolCallId ?? "");
      if (!id || turn.seenToolCalls.has(id)) return;
      turn.seenToolCalls.add(id);
      emitProgress(onToolCall, {
        id,
        name: String(record.toolName ?? "tool"),
        args: formatExternalToolCallArgs(record.args),
        input: record.args,
      });
      return;
    }
    case "tool_execution_end": {
      const result = asRecord(record.result);
      emitProgress(onToolResult, {
        id: String(record.toolCallId ?? ""),
        name: typeof record.toolName === "string" ? record.toolName : undefined,
        isError: record.isError === true,
        output: toolOutputText(result?.content ?? record.result),
      });
      return;
    }
    case "message_update": {
      const update = asRecord(record.assistantMessageEvent);
      if (update?.type === "text_end" && typeof update.content === "string")
        emitProgress(onText, update.content);
      else if (
        update?.type === "thinking_end" &&
        typeof update.content === "string"
      )
        emitProgress(onReasoning, update.content);
      return;
    }
    case "message_end": {
      const message = asRecord(record.message);
      if (message?.role !== "assistant") return;
      const text = assistantText(message.content);
      if (text) turn.lastText = text;
      turn.lastError =
        message.stopReason === "error" || message.stopReason === "aborted"
          ? typeof message.errorMessage === "string"
            ? message.errorMessage
            : `pi stopped: ${String(message.stopReason)}`
          : undefined;
      if (
        typeof message.provider === "string" &&
        typeof message.model === "string"
      )
        turn.model = `${message.provider}/${message.model}`;
      const usage = asRecord(message.usage);
      if (typeof usage?.totalTokens === "number")
        turn.totalTokens += usage.totalTokens;
      return;
    }
    case "agent_settled": {
      if (record.aborted === true)
        finish(session, turn, {
          success: false,
          report: turn.lastText ?? "",
          error: "pi turn was stopped",
        });
      else if (turn.lastError)
        finish(session, turn, {
          success: false,
          report: turn.lastText ?? "",
          error: turn.lastError,
        });
      else
        finish(session, turn, { success: true, report: turn.lastText ?? "" });
      return;
    }
  }
}

/** Split stdout on LF only; JSON strings may contain U+2028/U+2029. */
function readRecords(session: Session): void {
  const stdout = session.process.process.stdout;
  stdout.setEncoding("utf8");
  let buffer = "";
  stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line.trim()) continue;
      let record: PiRecord | undefined;
      try {
        record = asRecord(JSON.parse(line));
      } catch {
        continue;
      }
      if (record) onEvent(session, record);
    }
  });
}

function piArgs(options: PiTurnOptions, sessionArg: string[]): string[] {
  return [
    "--mode",
    "rpc",
    ...sessionArg,
    ...(options.model ? ["--model", options.model] : []),
    ...(options.mcpReminder
      ? ["--append-system-prompt", options.mcpReminder]
      : []),
  ];
}

async function createSession(
  options: PiTurnOptions,
  sessionId: string,
  env: NodeJS.ProcessEnv,
): Promise<Session> {
  let sessionArg = ["--session-id", sessionId];
  if (options.resumeSessionId) {
    // `--session-id` silently creates a new session when the ID belongs to
    // another working directory; resume by file so pi reopens the original.
    const path = await findPiSessionPath(sessionId, env);
    if (!path) throw new Error(`pi session ${sessionId} was not found`);
    sessionArg = ["--session", path];
  }
  const lifetime = new AbortController();
  let running: RunningSubagentProcess;
  try {
    running = spawnManagedWorkloadProcess("pi", piArgs(options, sessionArg), {
      cwd: options.cwd,
      env,
      signal: lifetime.signal,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("Required executable 'pi' was not found on PATH");
    throw error;
  }
  const session: Session = {
    key: sessionKey(options.parentAgentId, sessionId),
    id: sessionId,
    process: running,
    lifetime,
    pending: new Map(),
    stderr: "",
    lock: Promise.resolve(),
  };
  const spawnError = new Promise<never>((_, reject) => {
    running.process.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT"
          ? new Error("Required executable 'pi' was not found on PATH")
          : error,
      );
    });
  });
  spawnError.catch(() => undefined);
  running.process.stdin.on("error", () => undefined);
  running.process.stderr.setEncoding("utf8");
  running.process.stderr.on("data", (chunk: string) => {
    session.stderr = (session.stderr + chunk).slice(-4_000);
  });
  readRecords(session);
  void running.completion.then(({ exitCode }) => {
    if (!session.stopping)
      void dispose(
        session,
        `pi exited unexpectedly (code ${exitCode ?? "unknown"})${session.stderr.trim() ? `: ${session.stderr.trim().slice(-1_000)}` : ""}`,
      );
  });
  try {
    const state = await Promise.race([
      request(session, { type: "get_state" }),
      spawnError,
    ]);
    if (state.sessionId !== sessionId)
      throw new Error(
        `pi opened session ${String(state.sessionId)} instead of ${sessionId}`,
      );
  } catch (error) {
    await dispose(session, message(error));
    throw error;
  }
  sessions.set(session.key, session);
  return session;
}

async function getSession(
  options: PiTurnOptions,
  sessionId: string,
  env: NodeJS.ProcessEnv,
): Promise<Session> {
  const key = sessionKey(options.parentAgentId, sessionId);
  const loaded = sessions.get(key);
  if (loaded && !loaded.stopping) return loaded;
  const pending = creations.get(key);
  if (pending) return pending;
  const creation = createSession(options, sessionId, env).finally(() =>
    creations.delete(key),
  );
  creations.set(key, creation);
  return creation;
}

/** Start a turn; resolves once pi has accepted the prompt. */
async function start(session: Session, options: PiTurnOptions): Promise<Turn> {
  options.signal?.throwIfAborted();
  if (session.stopping) throw new Error("pi session is stopping");
  if (session.active) throw new Error("pi session already has an active turn");
  clearTimeout(session.idleTimer);
  await options.beforeStart?.(session.id);
  let resolve!: Turn["resolve"];
  const completion = new Promise<SubagentResult>((done) => {
    resolve = done;
  });
  const turn: Turn = {
    resolve,
    completion,
    startedAt: Date.now(),
    listeners: options,
    seenToolCalls: new Set(),
    model: options.model,
    totalTokens: 0,
  };
  session.active = turn;
  try {
    const accepted = await request(session, {
      type: "prompt",
      message: options.prompt,
    });
    if (accepted.disposition === "handled")
      finish(session, turn, { success: true, report: "" });
  } catch (error) {
    session.active = undefined;
    const text = message(error);
    throw new Error(
      /no api key|no models? (are )?available|not logged in|login/i.test(text)
        ? `${PI_NOT_SIGNED_IN_PREFIX} ${text.split("\n")[0]}`
        : text,
    );
  }
  options.onStarted?.(session.id);
  return turn;
}

/** Abort the active turn, then stop the process. */
async function interruptSession(session: Session): Promise<void> {
  if (session.active && !session.stopping) {
    try {
      await request(session, { type: "abort" });
    } catch {
      // The process is disposed below either way.
    }
  }
  await dispose(session, "pi turn cancelled");
}

export async function runPiTurn(
  options: PiTurnOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SubagentResult> {
  const sessionId = options.resumeSessionId ?? randomUUID();
  const startedAt = Date.now();
  let session: Session | undefined;
  const abort = () => {
    if (session) void interruptSession(session);
  };
  try {
    options.signal?.throwIfAborted();
    session = await getSession(options, sessionId, env);
    options.signal?.addEventListener("abort", abort, { once: true });
    const current = session;
    const turn = await withLock(current, () => start(current, options));
    if (options.signal?.aborted) abort();
    return await turn.completion;
  } catch (error) {
    if (session && !session.active) await dispose(session, message(error));
    return {
      agentId: options.resumeSessionId
        ? `pi_${options.resumeSessionId}`
        : options.parentAgentId,
      model: options.model,
      report: "",
      success: false,
      error: message(error),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}

/** Steer an active turn, or start a new turn on an existing session. */
export async function sendPiMessage(
  options: Omit<PiTurnOptions, "resumeSessionId"> & { sessionId: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<PiMessageReceipt> {
  options.signal?.throwIfAborted();
  const session = await getSession(
    { ...options, resumeSessionId: options.sessionId },
    options.sessionId,
    env,
  );
  return withLock(session, async () => {
    options.signal?.throwIfAborted();
    if (session.active) {
      await request(session, { type: "steer", message: options.prompt });
      return { mode: "steered" };
    }
    const turn = await start(session, { ...options, signal: undefined });
    return {
      mode: "new_turn",
      completion: turn.completion,
      interrupt: async () => {
        if (session.active === turn) await interruptSession(session);
      },
    };
  });
}

/** Native IDs for `letta model list --worker pi`. */
export async function listPiModels(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<Array<{ id: string; displayName: string }>> {
  const lifetime = new AbortController();
  const running = spawnManagedWorkloadProcess(
    "pi",
    ["--mode", "rpc", "--no-session"],
    { cwd, env, signal: lifetime.signal },
  );
  const session: Session = {
    key: "models",
    id: "models",
    process: running,
    lifetime,
    pending: new Map(),
    stderr: "",
    lock: Promise.resolve(),
  };
  const spawnError = new Promise<never>((_, reject) => {
    running.process.once("error", (error: NodeJS.ErrnoException) =>
      reject(
        error.code === "ENOENT"
          ? new Error("Required executable 'pi' was not found on PATH")
          : error,
      ),
    );
  });
  spawnError.catch(() => undefined);
  running.process.stdin.on("error", () => undefined);
  running.process.stderr.resume();
  readRecords(session);
  try {
    const data = await Promise.race([
      request(session, { type: "get_available_models" }),
      spawnError,
    ]);
    const models = Array.isArray(data.models) ? data.models : [];
    return models.flatMap((entry) => {
      const model = asRecord(entry);
      if (typeof model?.id !== "string" || typeof model.provider !== "string")
        return [];
      return [
        {
          id: `${model.provider}/${model.id}`,
          displayName:
            typeof model.name === "string" ? model.name : String(model.id),
        },
      ];
    });
  } finally {
    await dispose(session);
  }
}

export async function closePiSessions(): Promise<void> {
  await Promise.all([...sessions.values()].map((session) => dispose(session)));
}
