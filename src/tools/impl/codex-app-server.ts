import { spawn as nodeSpawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { SubagentResult } from "@/agent/subagents";

declare const LETTA_VERSION: string | undefined;

interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface CodexAppServerTransport {
  stdout: Readable;
  stderr?: Readable;
  stdin: Writable;
  kill?: () => void;
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

interface TurnWaiter {
  turnId: string;
  resolve: (value: SubagentResult) => void;
  startedAt: number;
  model?: string;
  latestAgentMessage?: string;
}

interface CodexSession {
  threadId: string;
  client: CodexAppServerClient;
  cwd: string;
  parentAgentId: string;
  model?: string;
  activeTurnId?: string;
  activeWaiter?: TurnWaiter;
  startLock: Promise<void>;
  pendingNotifications: JsonRpcMessage[];
  idleTimer?: ReturnType<typeof setTimeout>;
  idleTimeoutMs: number;
}

export interface CodexTurnOptions {
  prompt: string;
  parentAgentId: string;
  cwd: string;
  model?: string;
  mcpReminder?: string;
  signal?: AbortSignal;
  resumeThreadId?: string;
  onStarted?: (threadId: string, turnId: string) => void;
}

export interface CodexTurnHandle {
  threadId: string;
  turnId: string;
  completion: Promise<SubagentResult>;
}

export interface CodexMessageReceipt {
  mode: "steered" | "new_turn";
  threadId: string;
  turnId: string;
  completion?: Promise<SubagentResult>;
  interrupt?: () => Promise<void>;
}

export interface CodexAppServerDependencies {
  createTransport?: (options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
  }) => CodexAppServerTransport;
  env?: NodeJS.ProcessEnv;
  idleTimeoutMs?: number;
}

const sessions = new Map<string, CodexSession>();
const sessionCreations = new Map<string, Promise<CodexSession>>();
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function textInput(text: string): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text }];
}

function spawnTransport(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
}): CodexAppServerTransport {
  const child = nodeSpawn("codex", ["app-server", "--stdio"], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    kill: () => child.kill(),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  const record = asRecord(value);
  return typeof record?.[key] === "string"
    ? (record[key] as string)
    : undefined;
}

function turnError(params: Record<string, unknown>): string | undefined {
  const turn = asRecord(params.turn);
  const error = asRecord(turn?.error);
  return typeof error?.message === "string" ? error.message : undefined;
}

function turnReport(params: Record<string, unknown>): string {
  const turn = asRecord(params.turn);
  const items = Array.isArray(turn?.items) ? turn.items : [];
  for (let index = items.length - 1; index >= 0; index--) {
    const item = asRecord(items[index]);
    if (item?.type === "agentMessage" && typeof item.text === "string") {
      return item.text;
    }
  }
  return "";
}

class CodexAppServerClient {
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private stderr = "";
  private closed = false;

  constructor(
    private readonly transport: CodexAppServerTransport,
    private readonly onNotification: (message: JsonRpcMessage) => void,
    private readonly onClose: (error: Error) => void,
  ) {
    const stdout = createInterface({ input: transport.stdout });
    stdout.on("line", (line) => {
      if (!line.trim()) return;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        return;
      }
      if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(
            new Error(message.error.message ?? "Codex request failed"),
          );
        } else {
          pending.resolve(message.result ?? {});
        }
        return;
      }
      if (message.method) this.onNotification(message);
    });
    transport.stderr?.setEncoding("utf8");
    transport.stderr?.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    const close = () => this.close();
    transport.stdout.once("close", close);
    transport.stdout.once("error", close);
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "letta-code",
        version: typeof LETTA_VERSION === "undefined" ? "0" : LETTA_VERSION,
      },
      capabilities: null,
    });
    this.notify("initialized", {});
  }

  request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (this.closed)
      return Promise.reject(new Error("Codex app-server closed"));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.transport.stdin.write(
        `${JSON.stringify({ id, method, params })}\n`,
        (error) => {
          if (!error) return;
          this.pending.delete(id);
          reject(error);
        },
      );
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (!this.closed) {
      this.transport.stdin.write(`${JSON.stringify({ method, params })}\n`);
    }
  }

  dispose(): void {
    this.transport.kill?.();
    this.close();
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    const detail = this.stderr.trim();
    const error = new Error(
      `Codex app-server closed${detail ? `: ${detail}` : ""}`,
    );
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.onClose(error);
  }
}

function failSession(session: CodexSession, error: Error): void {
  clearIdleSessionCleanup(session);
  if (sessions.get(session.threadId) === session)
    sessions.delete(session.threadId);
  const waiter = session.activeWaiter;
  session.activeTurnId = undefined;
  session.activeWaiter = undefined;
  if (!waiter) return;
  waiter.resolve({
    agentId: `codex_${session.threadId}`,
    runtimeSessionId: session.threadId,
    model: waiter.model,
    report: waiter.latestAgentMessage ?? "",
    success: false,
    error: error.message,
    durationMs: Date.now() - waiter.startedAt,
  });
}

function recordCompletedItem(
  session: CodexSession,
  params: Record<string, unknown>,
): boolean {
  const turnId = readString(params, "turnId");
  if (turnId !== session.activeTurnId || !session.activeWaiter) return false;
  const item = asRecord(params.item);
  if (item?.type === "agentMessage" && typeof item.text === "string") {
    session.activeWaiter.latestAgentMessage = item.text;
  }
  return true;
}

function settleTurn(
  session: CodexSession,
  params: Record<string, unknown>,
): boolean {
  const turn = asRecord(params.turn);
  const turnId = readString(turn, "id");
  if (!turnId || turnId !== session.activeTurnId || !session.activeWaiter) {
    return false;
  }
  const waiter = session.activeWaiter;
  session.activeTurnId = undefined;
  session.activeWaiter = undefined;
  const status = readString(turn, "status");
  const failure = turnError(params);
  waiter.resolve({
    agentId: `codex_${session.threadId}`,
    runtimeSessionId: session.threadId,
    model: waiter.model,
    report: turnReport(params) || waiter.latestAgentMessage || "",
    success: status === "completed",
    ...(status === "completed"
      ? {}
      : { error: failure ?? `Codex turn ${status ?? "failed"}` }),
    durationMs: Date.now() - waiter.startedAt,
  });
  scheduleIdleSessionCleanup(session);
  return true;
}

function handleNotification(
  session: CodexSession,
  message: JsonRpcMessage,
): boolean {
  if (!message.params) return true;
  if (message.method === "item/completed") {
    return recordCompletedItem(session, message.params);
  }
  if (message.method === "turn/completed") {
    return settleTurn(session, message.params);
  }
  return true;
}

function replayPendingNotifications(session: CodexSession): void {
  const pending = session.pendingNotifications;
  session.pendingNotifications = [];
  for (const message of pending) {
    if (!handleNotification(session, message)) {
      session.pendingNotifications.push(message);
    }
  }
}

function clearIdleSessionCleanup(session: CodexSession): void {
  if (!session.idleTimer) return;
  clearTimeout(session.idleTimer);
  session.idleTimer = undefined;
}

function disposeSession(session: CodexSession): void {
  clearIdleSessionCleanup(session);
  if (sessions.get(session.threadId) === session)
    sessions.delete(session.threadId);
  session.client.dispose();
}

function scheduleIdleSessionCleanup(session: CodexSession): void {
  clearIdleSessionCleanup(session);
  session.idleTimer = setTimeout(
    () => disposeSession(session),
    session.idleTimeoutMs,
  );
  session.idleTimer.unref?.();
}

async function createSession(
  options: CodexTurnOptions,
  deps: CodexAppServerDependencies,
): Promise<CodexSession> {
  const env = {
    ...(deps.env ?? process.env),
    AGENT_ID: options.parentAgentId,
    LETTA_AGENT_ID: options.parentAgentId,
  };
  const transport = (deps.createTransport ?? spawnTransport)({
    cwd: options.cwd,
    env,
  });
  let session: CodexSession | undefined;
  const pendingNotifications: JsonRpcMessage[] = [];
  const client = new CodexAppServerClient(
    transport,
    (message) => {
      if (!session || !handleNotification(session, message)) {
        pendingNotifications.push(message);
      }
    },
    (error) => {
      if (session) failSession(session, error);
    },
  );
  let response: Record<string, unknown>;
  try {
    await client.initialize();
    const method = options.resumeThreadId ? "thread/resume" : "thread/start";
    const params = options.resumeThreadId
      ? { threadId: options.resumeThreadId }
      : {
          cwd: options.cwd,
          model: options.model,
          approvalPolicy: "never",
          sandbox: "workspace-write",
          developerInstructions: options.mcpReminder,
        };
    response = await client.request(method, params);
  } catch (error) {
    client.dispose();
    throw error;
  }
  const thread = asRecord(response.thread);
  const threadId = readString(thread, "id");
  if (!threadId) {
    client.dispose();
    throw new Error("Codex app-server returned no native thread ID");
  }
  session = {
    threadId,
    client,
    cwd: readString(thread, "cwd") ?? options.cwd,
    parentAgentId: options.parentAgentId,
    model: options.model,
    startLock: Promise.resolve(),
    pendingNotifications,
    idleTimeoutMs: deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
  };
  sessions.set(threadId, session);
  return session;
}

async function withSessionLock<T>(
  session: CodexSession,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = session.startLock;
  let release!: () => void;
  session.startLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

async function startTurnUnlocked(
  session: CodexSession,
  prompt: string,
  signal?: AbortSignal,
): Promise<CodexTurnHandle> {
  if (session.activeTurnId) {
    throw new Error("Codex thread already has an active turn");
  }
  clearIdleSessionCleanup(session);
  const response = await session.client.request("turn/start", {
    threadId: session.threadId,
    input: textInput(prompt),
    cwd: session.cwd,
    model: session.model,
    approvalPolicy: "never",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [session.cwd],
      networkAccess: true,
    },
  });
  const turn = asRecord(response.turn);
  const turnId = readString(turn, "id");
  if (!turnId) throw new Error("Codex app-server returned no native turn ID");
  const completion = new Promise<SubagentResult>((resolve) => {
    session.activeTurnId = turnId;
    session.activeWaiter = {
      turnId,
      resolve,
      startedAt: Date.now(),
      model: session.model,
    };
  });
  replayPendingNotifications(session);
  const abort = () => {
    void session.client
      .request("turn/interrupt", { threadId: session.threadId, turnId })
      .catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  completion.finally(() => signal?.removeEventListener("abort", abort));
  return { threadId: session.threadId, turnId, completion };
}

function startTurn(
  session: CodexSession,
  prompt: string,
  signal?: AbortSignal,
): Promise<CodexTurnHandle> {
  return withSessionLock(session, () =>
    startTurnUnlocked(session, prompt, signal),
  );
}

export async function startCodexTurn(
  options: CodexTurnOptions,
  deps: CodexAppServerDependencies = {},
): Promise<CodexTurnHandle> {
  const session = await createSession(options, deps);
  try {
    const handle = await startTurn(session, options.prompt, options.signal);
    options.onStarted?.(handle.threadId, handle.turnId);
    return handle;
  } catch (error) {
    disposeSession(session);
    throw error;
  }
}

async function resumeSession(
  threadId: string,
  options: Omit<CodexTurnOptions, "prompt" | "resumeThreadId">,
  deps: CodexAppServerDependencies,
): Promise<CodexSession> {
  const loaded = sessions.get(threadId);
  if (loaded) {
    clearIdleSessionCleanup(loaded);
    return loaded;
  }
  const pending = sessionCreations.get(threadId);
  if (pending) return pending;
  const creation = createSession(
    { ...options, prompt: "", resumeThreadId: threadId },
    deps,
  ).finally(() => sessionCreations.delete(threadId));
  sessionCreations.set(threadId, creation);
  return creation;
}

export async function sendCodexMessage(
  options: Omit<CodexTurnOptions, "resumeThreadId"> & { threadId: string },
  deps: CodexAppServerDependencies = {},
): Promise<CodexMessageReceipt> {
  const session = await resumeSession(options.threadId, options, deps);
  try {
    return await withSessionLock(session, async () => {
      const activeTurnId = session.activeTurnId;
      if (activeTurnId) {
        try {
          await session.client.request("turn/steer", {
            threadId: session.threadId,
            expectedTurnId: activeTurnId,
            input: textInput(options.prompt),
          });
          return {
            mode: "steered",
            threadId: session.threadId,
            turnId: activeTurnId,
          };
        } catch (error) {
          if (session.activeTurnId === activeTurnId) throw error;
          // The matching turn completed while steering. Start exactly one new turn.
        }
      }
      options.signal?.throwIfAborted();
      const handle = await startTurnUnlocked(session, options.prompt);
      if (options.signal?.aborted) {
        await session.client.request("turn/interrupt", {
          threadId: handle.threadId,
          turnId: handle.turnId,
        });
        options.signal.throwIfAborted();
      }
      return {
        mode: "new_turn",
        threadId: handle.threadId,
        turnId: handle.turnId,
        completion: handle.completion,
        interrupt: async () => {
          await session.client.request("turn/interrupt", {
            threadId: handle.threadId,
            turnId: handle.turnId,
          });
        },
      };
    });
  } catch (error) {
    if (!session.activeTurnId && sessions.get(session.threadId) === session) {
      scheduleIdleSessionCleanup(session);
    }
    throw error;
  }
}

export async function runCodexTurn(
  options: CodexTurnOptions,
  deps: CodexAppServerDependencies = {},
): Promise<SubagentResult> {
  try {
    return await (await startCodexTurn(options, deps)).completion;
  } catch (error) {
    return {
      agentId: options.resumeThreadId
        ? `codex_${options.resumeThreadId}`
        : options.parentAgentId,
      runtimeSessionId: options.resumeThreadId,
      model: options.model,
      report: "",
      success: false,
      error: errorMessage(error),
    };
  }
}

export function hasActiveCodexTurn(threadId: string): boolean {
  return Boolean(sessions.get(threadId)?.activeTurnId);
}

export function __resetCodexSessionsForTests(): void {
  for (const session of sessions.values()) session.client.dispose();
  sessions.clear();
  sessionCreations.clear();
}
