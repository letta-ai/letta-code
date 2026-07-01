import { type ChildProcess, spawn } from "node:child_process";
import { getCurrentWorkingDirectory } from "@/runtime-context";
import { noteExpectedWorktreeForLauncher } from "@/websocket/listener/worktree-ownership";
import {
  appendBackgroundProcessOutput,
  appendToOutputFile,
  assertBackgroundProcessCapacity,
  backgroundProcesses,
  createBackgroundOutputFile,
  getNextExecSessionId,
  scheduleBackgroundProcessCleanup,
} from "./process_manager.js";
import { resolveShellWorkdir } from "./shell.js";
import { getShellEnv } from "./shell-env.js";
import {
  buildPowerShellCommand,
  buildShellLaunchers,
  selectAvailableShellLauncher,
} from "./shell-launchers.js";
import { applyShellSandbox } from "./shell-sandbox.js";
import { LIMITS, truncateByChars } from "./truncation.js";
import { validateRequiredParams } from "./validation.js";

const DEFAULT_EXEC_YIELD_TIME_MS = 10_000;
const DEFAULT_WRITE_STDIN_YIELD_TIME_MS = 250;
const MIN_YIELD_TIME_MS = 250;
const MIN_EMPTY_WRITE_STDIN_YIELD_TIME_MS = 5_000;
const MAX_YIELD_TIME_MS = 30_000;
const MAX_EMPTY_WRITE_STDIN_YIELD_TIME_MS = 300_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const MAX_INLINE_OUTPUT_CHARS = LIMITS.BASH_OUTPUT_CHARS;
const MAX_SESSION_OUTPUT_CHARS = 1_000_000;
const EXEC_SESSION_CLEANUP_MS = 5 * 60 * 1000;

interface ExecCommandArgs {
  cmd: string;
  description?: string;
  workdir?: string;
  shell?: string;
  tty?: boolean;
  yield_time_ms?: number;
  max_output_tokens?: number;
  login?: boolean;
  // Upstream Codex also exposes sandbox-escalation fields here:
  // sandbox_permissions, justification, prefix_rule, additional_permissions.
  // Letta Code intentionally omits them from the model-facing schema because
  // this harness has no Codex sandbox override / permission-profile layer;
  // the regular Letta Code approval system still gates command execution.
  signal?: AbortSignal;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  secretEnv?: Record<string, string>;
}

interface WriteStdinArgs {
  session_id: number | string;
  chars?: string;
  yield_time_ms?: number;
  max_output_tokens?: number;
  signal?: AbortSignal;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
}

interface ExecCommandResult {
  output: string;
}

type ExecSessionStatus = "running" | "completed" | "failed";

interface ExecSession {
  id: string;
  command: string;
  output: string;
  chunks: ExecOutputChunk[];
  readOffset: number;
  status: ExecSessionStatus;
  exitCode: number | null;
  tty: boolean;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

type ProcessLauncher = {
  kill(signal?: string | number): unknown;
  write(input: string): void;
};

type NodePtyExitEvent = { exitCode?: number; signal?: number };

type NodePtyProcess = {
  pid: number;
  write: (data: string) => void;
  kill: (signal?: string) => void;
  onData: (listener: (data: string) => void) => void;
  onExit: (listener: (event: NodePtyExitEvent) => void) => void;
};

type NodePtyModule = {
  spawn: (
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
    },
  ) => NodePtyProcess;
};

const NODE_PTY_BRIDGE_SCRIPT = `
const pty = require("node-pty");
const config = JSON.parse(process.argv[1]);
const child = pty.spawn(config.executable, config.args, {
  name: "xterm-256color",
  cols: 80,
  rows: 24,
  cwd: config.cwd,
  env: process.env,
});
child.onData((data) => process.stdout.write(data));
child.onExit(({ exitCode }) => process.exit(typeof exitCode === "number" ? exitCode : 1));
process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => child.write(data));
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
`;

type ExecOutputChunk = {
  text: string;
  stream: "stdout" | "stderr";
  start: number;
  end: number;
};

const execSessions = new Map<string, ExecSession>();

function createAbortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function clampYieldTime(value: number | undefined, fallback: number): number {
  const time = Number.isFinite(value) ? Number(value) : fallback;
  return Math.max(MIN_YIELD_TIME_MS, Math.min(time, MAX_YIELD_TIME_MS));
}

function clampWriteStdinYieldTime(
  value: number | undefined,
  input: string,
): number {
  const time = Math.max(
    MIN_YIELD_TIME_MS,
    Number.isFinite(value) ? Number(value) : DEFAULT_WRITE_STDIN_YIELD_TIME_MS,
  );
  if (input.length === 0) {
    return Math.max(
      MIN_EMPTY_WRITE_STDIN_YIELD_TIME_MS,
      Math.min(time, MAX_EMPTY_WRITE_STDIN_YIELD_TIME_MS),
    );
  }
  return Math.min(time, MAX_YIELD_TIME_MS);
}

function estimateTokenCount(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

function maxCharsForTokens(maxOutputTokens?: number): number {
  const maxTokens =
    maxOutputTokens && maxOutputTokens > 0
      ? maxOutputTokens
      : DEFAULT_MAX_OUTPUT_TOKENS;
  return Math.min(Math.max(1, maxTokens * 4), MAX_INLINE_OUTPUT_CHARS);
}

function truncateOutput(text: string, maxOutputTokens?: number): string {
  return truncateByChars(
    text,
    maxCharsForTokens(maxOutputTokens),
    "exec_command",
    {
      workingDirectory: getCurrentWorkingDirectory(),
      toolName: "exec_command",
    },
  ).content;
}

function appendSessionOutput(
  session: ExecSession,
  text: string,
  stream: "stdout" | "stderr",
): void {
  const start = session.output.length;
  session.output += text;
  const end = session.output.length;
  session.chunks.push({ text, stream, start, end });

  if (session.output.length <= MAX_SESSION_OUTPUT_CHARS) {
    return;
  }

  const removedChars = session.output.length - MAX_SESSION_OUTPUT_CHARS;
  session.output = session.output.slice(removedChars);
  session.readOffset = Math.max(0, session.readOffset - removedChars);
  session.chunks = session.chunks
    .map((chunk) => ({
      ...chunk,
      start: chunk.start - removedChars,
      end: chunk.end - removedChars,
    }))
    .filter((chunk) => chunk.end > 0)
    .map((chunk) => {
      if (chunk.start >= 0) {
        return chunk;
      }
      return {
        ...chunk,
        text: chunk.text.slice(-chunk.end),
        start: 0,
      };
    });
}

function getSessionOutputChunks(
  session: ExecSession,
  startOffset: number,
  endOffset: number,
): ExecOutputChunk[] {
  const chunks: ExecOutputChunk[] = [];
  for (const chunk of session.chunks) {
    if (chunk.end <= startOffset || chunk.start >= endOffset) {
      continue;
    }
    const sliceStart = Math.max(0, startOffset - chunk.start);
    const sliceEnd = Math.min(chunk.text.length, endOffset - chunk.start);
    const text = chunk.text.slice(sliceStart, sliceEnd);
    if (text) {
      chunks.push({
        text,
        stream: chunk.stream,
        start: Math.max(chunk.start, startOffset),
        end: Math.min(chunk.end, endOffset),
      });
    }
  }
  return chunks;
}

function scheduleExecSessionCleanup(sessionId: string): void {
  const session = execSessions.get(sessionId);
  if (!session || session.status === "running") {
    return;
  }
  if (session.cleanupTimer) {
    clearTimeout(session.cleanupTimer);
  }
  session.cleanupTimer = setTimeout(() => {
    const current = execSessions.get(sessionId);
    if (current === session && current.status !== "running") {
      execSessions.delete(sessionId);
    }
  }, EXEC_SESSION_CLEANUP_MS);
  if (
    typeof session.cleanupTimer === "object" &&
    "unref" in session.cleanupTimer
  ) {
    session.cleanupTimer.unref();
  }
}

function releaseExecSession(session: ExecSession): void {
  if (session.cleanupTimer) {
    clearTimeout(session.cleanupTimer);
    session.cleanupTimer = undefined;
  }
  execSessions.delete(session.id);
}

function formatExecOutput(params: {
  chunkId: string;
  wallTimeMs: number;
  exitCode: number | null;
  sessionId: string | null;
  output: string;
  originalTokenCount: number;
  maxOutputTokens?: number;
}): string {
  const sections = [
    `Chunk ID: ${params.chunkId}`,
    `Wall time: ${(params.wallTimeMs / 1000).toFixed(4)} seconds`,
  ];

  if (params.exitCode !== null) {
    sections.push(`Process exited with code ${params.exitCode}`);
  }
  if (params.sessionId !== null) {
    sections.push(`Process running with session ID ${params.sessionId}`);
  }

  sections.push(`Original token count: ${params.originalTokenCount}`);
  sections.push("Output:");
  sections.push(truncateOutput(params.output, params.maxOutputTokens));
  return sections.join("\n");
}

function generateChunkId(): string {
  return Array.from({ length: 6 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("");
}

function shellCommandFlag(shellName: string, login: boolean): string {
  if (!login) return "-c";
  const normalized = shellName.replace(/\\/g, "/").toLowerCase();
  if (normalized.includes("bash") || normalized.includes("zsh")) {
    return "-lc";
  }
  return "-c";
}

function isPowerShell(shell: string): boolean {
  const normalized = shell.replace(/\\/g, "/").toLowerCase();
  return normalized.includes("powershell") || normalized.includes("pwsh");
}

function isCmd(shell: string): boolean {
  const normalized = shell.replace(/\\/g, "/").toLowerCase();
  return normalized.endsWith("cmd.exe") || normalized.endsWith("/cmd");
}

function buildExplicitShellLauncher(
  shell: string,
  cmd: string,
  login: boolean,
  envAliases?: string[],
): string[] {
  if (process.platform === "win32") {
    if (isPowerShell(shell)) {
      return [
        shell,
        "-NoProfile",
        "-Command",
        buildPowerShellCommand(cmd, envAliases),
      ];
    }
    if (isCmd(shell)) {
      return [shell, "/d", "/s", "/c", cmd];
    }
  }
  return [shell, shellCommandFlag(shell, login), cmd];
}

function buildExecLaunchers(args: ExecCommandArgs): string[][] {
  const login = args.login ?? true;
  const envAliases = args.secretEnv ? Object.keys(args.secretEnv) : undefined;
  if (args.shell?.trim()) {
    return [
      buildExplicitShellLauncher(
        args.shell.trim(),
        args.cmd,
        login,
        envAliases,
      ),
    ];
  }
  return buildShellLaunchers(args.cmd, {
    login,
    powershellEnvAliases: envAliases,
  });
}

function buildPtyEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const ptyEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      ptyEnv[key] = value;
    }
  }
  ptyEnv.TERM = ptyEnv.TERM || "xterm-256color";
  ptyEnv.COLORTERM = ptyEnv.COLORTERM || "truecolor";
  return ptyEnv;
}

function createSessionOutputAppender(params: {
  session: ExecSession;
  outputFile: string;
}): (text: string, stream: "stdout" | "stderr") => void {
  return (text: string, stream: "stdout" | "stderr") => {
    appendSessionOutput(params.session, text, stream);
    const bgProcess = backgroundProcesses.get(params.session.id);
    if (bgProcess) {
      appendBackgroundProcessOutput(bgProcess, stream, text);
    }
    appendToOutputFile(params.outputFile, text);
  };
}

function markSessionFailed(session: ExecSession): void {
  session.status = "failed";
  const bgProcess = backgroundProcesses.get(session.id);
  if (bgProcess) {
    bgProcess.status = "failed";
    scheduleBackgroundProcessCleanup(session.id);
  }
  scheduleExecSessionCleanup(session.id);
}

function markSessionClosed(session: ExecSession, code: number | null): void {
  session.status = code === 0 ? "completed" : "failed";
  session.exitCode = code;
  const bgProcess = backgroundProcesses.get(session.id);
  if (bgProcess) {
    bgProcess.status = session.status;
    bgProcess.exitCode = code;
    scheduleBackgroundProcessCleanup(session.id);
  }
  scheduleExecSessionCleanup(session.id);
}

function spawnPipeProcess(params: {
  launcher: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  session: ExecSession;
  outputFile: string;
}): ProcessLauncher {
  const [executable, ...args] = params.launcher;
  if (!executable) {
    throw new Error("Executable is required");
  }

  noteExpectedWorktreeForLauncher(params.launcher, params.cwd);
  const childProcess: ChildProcess = spawn(executable, args, {
    cwd: params.cwd,
    env: params.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  const appendOutput = createSessionOutputAppender(params);

  childProcess.stdout?.on("data", (chunk: Buffer) => {
    appendOutput(chunk.toString("utf8"), "stdout");
  });
  childProcess.stderr?.on("data", (chunk: Buffer) => {
    appendOutput(chunk.toString("utf8"), "stderr");
  });

  childProcess.on("error", (error) => {
    appendOutput(error.message, "stderr");
    markSessionFailed(params.session);
  });

  childProcess.on("close", (code) => {
    markSessionClosed(params.session, code);
  });

  return {
    kill(signal?: string | number) {
      if (childProcess.pid && process.platform !== "win32") {
        try {
          process.kill(-childProcess.pid, signal as NodeJS.Signals);
          return;
        } catch {
          // Fall back to killing the child directly below.
        }
      }
      childProcess.kill(signal as NodeJS.Signals);
    },
    write(input: string) {
      childProcess.stdin?.write(input);
    },
  };
}

function spawnPtyProcess(params: {
  launcher: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  session: ExecSession;
  outputFile: string;
}): ProcessLauncher {
  const [executable, ...args] = params.launcher;
  if (!executable) {
    throw new Error("Executable is required");
  }

  noteExpectedWorktreeForLauncher(params.launcher, params.cwd);
  const appendOutput = createSessionOutputAppender(params);
  const ptyEnv = buildPtyEnv(params.env);

  if (typeof Bun !== "undefined") {
    // node-pty's native handles do not integrate reliably when loaded into
    // Bun's event loop. Local Bun dev/tests run the PTY inside a tiny Node
    // bridge; the distributed CLI runs under Node and uses node-pty directly.
    const childProcess: ChildProcess = spawn(
      "node",
      [
        "-e",
        NODE_PTY_BRIDGE_SCRIPT,
        JSON.stringify({ executable, args, cwd: params.cwd }),
      ],
      {
        cwd: params.cwd,
        env: ptyEnv,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );

    childProcess.stdout?.on("data", (chunk: Buffer) => {
      appendOutput(chunk.toString("utf8"), "stdout");
    });
    childProcess.stderr?.on("data", (chunk: Buffer) => {
      appendOutput(chunk.toString("utf8"), "stderr");
    });
    childProcess.on("error", (error) => {
      appendOutput(error.message, "stderr");
      markSessionFailed(params.session);
    });
    childProcess.on("close", (code) => {
      markSessionClosed(params.session, code);
    });

    return {
      kill(signal?: string | number) {
        if (childProcess.pid && process.platform !== "win32") {
          try {
            process.kill(-childProcess.pid, signal as NodeJS.Signals);
            return;
          } catch {
            // Fall back to killing the bridge directly below.
          }
        }
        childProcess.kill(signal as NodeJS.Signals);
      },
      write(input: string) {
        childProcess.stdin?.write(input);
      },
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pty = require("node-pty") as NodePtyModule;
  const ptyProcess = pty.spawn(executable, args, {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: params.cwd,
    env: ptyEnv,
  });

  ptyProcess.onData((data) => appendOutput(data, "stdout"));
  ptyProcess.onExit(({ exitCode }) => {
    markSessionClosed(
      params.session,
      typeof exitCode === "number" ? exitCode : null,
    );
  });

  return {
    kill(signal?: string | number) {
      ptyProcess.kill(typeof signal === "string" ? signal : undefined);
    },
    write(input: string) {
      ptyProcess.write(input);
    },
  };
}

async function waitForSessionOutput(params: {
  session: ExecSession;
  startOffset: number;
  yieldTimeMs: number;
  signal?: AbortSignal;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
}): Promise<{ output: string; wallTimeMs: number }> {
  const startTime = Date.now();
  const deadline = startTime + params.yieldTimeMs;
  let emittedOffset = params.startOffset;

  throwIfAborted(params.signal);
  while (Date.now() < deadline && params.session.status === "running") {
    if (params.onOutput && params.session.output.length > emittedOffset) {
      for (const chunk of getSessionOutputChunks(
        params.session,
        emittedOffset,
        params.session.output.length,
      )) {
        params.onOutput(chunk.text, chunk.stream);
      }
      emittedOffset = params.session.output.length;
    }
    await sleep(25, params.signal);
  }
  throwIfAborted(params.signal);

  if (params.onOutput && params.session.output.length > emittedOffset) {
    for (const chunk of getSessionOutputChunks(
      params.session,
      emittedOffset,
      params.session.output.length,
    )) {
      params.onOutput(chunk.text, chunk.stream);
    }
  }

  const endOffset = params.session.output.length;
  const output = params.session.output.slice(params.startOffset, endOffset);
  params.session.readOffset = endOffset;

  return { output, wallTimeMs: Date.now() - startTime };
}

async function startExecSession(args: ExecCommandArgs): Promise<ExecSession> {
  assertBackgroundProcessCapacity();

  const id = getNextExecSessionId();
  const outputFile = createBackgroundOutputFile(`exec_${id}`);
  const cwd = resolveShellWorkdir(args.workdir);
  const env = { ...getShellEnv(), ...(args.secretEnv ?? {}) };
  const launchers = buildExecLaunchers(args);
  const rawLauncher = selectAvailableShellLauncher(launchers, env);
  if (!rawLauncher) {
    throw new Error("Command must be a non-empty string");
  }
  // Confine the session (pipe or PTY) under the cross-agent shell sandbox.
  // The spawn helpers re-note the launcher for worktree ownership, but the
  // wrapper hides the inner shell from that inspection, so note the unwrapped
  // launcher here first.
  const sandboxed = applyShellSandbox(rawLauncher, cwd, env);
  if (sandboxed.backend) {
    noteExpectedWorktreeForLauncher(rawLauncher, cwd);
  }
  const launcher = sandboxed.launcher;
  const spawnEnv = sandboxed.env;

  const session: ExecSession = {
    id,
    command: args.cmd,
    output: "",
    chunks: [],
    readOffset: 0,
    status: "running",
    exitCode: null,
    tty: args.tty ?? false,
  };
  execSessions.set(id, session);

  let processLauncher: ProcessLauncher;
  try {
    const spawnProcess = session.tty ? spawnPtyProcess : spawnPipeProcess;
    processLauncher = spawnProcess({
      launcher,
      cwd,
      env: spawnEnv,
      session,
      outputFile,
    });
  } catch (error) {
    execSessions.delete(id);
    throw error;
  }

  backgroundProcesses.set(id, {
    process: processLauncher,
    command: args.cmd,
    stdout: [],
    stderr: [],
    status: session.status,
    exitCode: session.exitCode,
    lastReadIndex: { stdout: 0, stderr: 0 },
    startTime: new Date(),
    outputFile,
    totalStdoutLines: 0,
    totalStderrLines: 0,
  });
  if (session.status !== "running") {
    scheduleBackgroundProcessCleanup(id);
  }

  args.signal?.addEventListener(
    "abort",
    () => {
      processLauncher.kill("SIGTERM");
    },
    { once: true },
  );

  return session;
}

export async function exec_command(
  args: ExecCommandArgs,
): Promise<ExecCommandResult> {
  validateRequiredParams(args, ["cmd"], "exec_command");
  if (!args.cmd || typeof args.cmd !== "string") {
    throw new Error("cmd must be a non-empty string");
  }

  const session = await startExecSession(args);
  const yieldTimeMs = clampYieldTime(
    args.yield_time_ms,
    DEFAULT_EXEC_YIELD_TIME_MS,
  );
  const { output, wallTimeMs } = await waitForSessionOutput({
    session,
    startOffset: 0,
    yieldTimeMs,
    signal: args.signal,
    onOutput: args.onOutput,
  });

  const sessionId = session.status === "running" ? session.id : null;
  const formattedOutput = formatExecOutput({
    chunkId: generateChunkId(),
    wallTimeMs,
    exitCode: session.exitCode,
    sessionId,
    output,
    originalTokenCount: estimateTokenCount(output),
    maxOutputTokens: args.max_output_tokens,
  });
  if (sessionId === null) {
    releaseExecSession(session);
  }

  return {
    output: formattedOutput,
  };
}

export async function write_stdin(
  args: WriteStdinArgs,
): Promise<ExecCommandResult> {
  validateRequiredParams(args, ["session_id"], "write_stdin");
  const sessionId = String(args.session_id);
  const session = execSessions.get(sessionId);
  const backgroundProcess = backgroundProcesses.get(sessionId);
  if (!session || !backgroundProcess) {
    throw new Error(`Unknown process id ${sessionId}`);
  }

  const chars = args.chars ?? "";
  if (chars && !session.tty) {
    throw new Error(
      "stdin is closed for this session; rerun exec_command with tty=true to keep stdin open",
    );
  }
  if (chars) {
    (backgroundProcess.process as ProcessLauncher).write(chars);
    await sleep(100, args.signal);
  }

  const startOffset = session.readOffset;
  const yieldTimeMs = clampWriteStdinYieldTime(args.yield_time_ms, chars);
  const { output, wallTimeMs } = await waitForSessionOutput({
    session,
    startOffset,
    yieldTimeMs,
    signal: args.signal,
    onOutput: args.onOutput,
  });

  const nextSessionId = session.status === "running" ? session.id : null;
  const formattedOutput = formatExecOutput({
    chunkId: generateChunkId(),
    wallTimeMs,
    exitCode: session.exitCode,
    sessionId: nextSessionId,
    output,
    originalTokenCount: estimateTokenCount(output),
    maxOutputTokens: args.max_output_tokens,
  });
  if (nextSessionId === null) {
    releaseExecSession(session);
  }

  return {
    output: formattedOutput,
  };
}

export function __clearExecSessionsForTests(): void {
  for (const session of execSessions.values()) {
    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer);
    }
  }
  execSessions.clear();
}

export function __getExecSessionForTests(
  sessionId: string,
): ExecSession | undefined {
  return execSessions.get(sessionId);
}
