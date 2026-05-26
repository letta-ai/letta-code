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
} from "./shell-launchers.js";
import { LIMITS, truncateByChars } from "./truncation.js";
import { validateRequiredParams } from "./validation.js";

const DEFAULT_EXEC_YIELD_TIME_MS = 10_000;
const DEFAULT_WRITE_STDIN_YIELD_TIME_MS = 250;
const MAX_YIELD_TIME_MS = 30_000;
const MAX_SESSION_OUTPUT_CHARS = 1_000_000;
const EXEC_SESSION_CLEANUP_MS = 5 * 60 * 1000;

interface ExecCommandArgs {
  cmd: string;
  workdir?: string;
  shell?: string;
  tty?: boolean;
  yield_time_ms?: number;
  max_output_tokens?: number;
  login?: boolean;
  sandbox_permissions?: "use_default" | "require_escalated" | string;
  justification?: string;
  prefix_rule?: string[];
  signal?: AbortSignal;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  secretEnv?: Record<string, string>;
}

interface WriteStdinArgs {
  session_id: number | string;
  chars?: string;
  yield_time_ms?: number;
  max_output_tokens?: number;
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

const execSessions = new Map<string, ExecSession>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampYieldTime(value: number | undefined, fallback: number): number {
  const time = Number.isFinite(value) ? Number(value) : fallback;
  return Math.max(0, Math.min(time, MAX_YIELD_TIME_MS));
}

function estimateTokenCount(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

function maxCharsForTokens(maxOutputTokens?: number): number {
  if (!maxOutputTokens || maxOutputTokens <= 0) {
    return LIMITS.BASH_OUTPUT_CHARS;
  }
  return Math.max(1, maxOutputTokens * 4);
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

function appendSessionOutput(session: ExecSession, text: string): void {
  session.output += text;
  if (session.output.length <= MAX_SESSION_OUTPUT_CHARS) {
    return;
  }

  const removedChars = session.output.length - MAX_SESSION_OUTPUT_CHARS;
  session.output = session.output.slice(removedChars);
  session.readOffset = Math.max(0, session.readOffset - removedChars);
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
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  const appendOutput = (text: string, stream: "stdout" | "stderr") => {
    appendSessionOutput(params.session, text);
    const bgProcess = backgroundProcesses.get(params.session.id);
    if (bgProcess) {
      appendBackgroundProcessOutput(bgProcess, stream, text);
    }
    appendToOutputFile(params.outputFile, text);
  };

  childProcess.stdout?.on("data", (chunk: Buffer) => {
    appendOutput(chunk.toString("utf8"), "stdout");
  });
  childProcess.stderr?.on("data", (chunk: Buffer) => {
    appendOutput(chunk.toString("utf8"), "stderr");
  });

  childProcess.on("error", (error) => {
    params.session.status = "failed";
    appendOutput(error.message, "stderr");
    const bgProcess = backgroundProcesses.get(params.session.id);
    if (bgProcess) {
      bgProcess.status = "failed";
      scheduleBackgroundProcessCleanup(params.session.id);
    }
    scheduleExecSessionCleanup(params.session.id);
  });

  childProcess.on("close", (code) => {
    params.session.status = code === 0 ? "completed" : "failed";
    params.session.exitCode = code;
    const bgProcess = backgroundProcesses.get(params.session.id);
    if (bgProcess) {
      bgProcess.status = params.session.status;
      bgProcess.exitCode = code;
      scheduleBackgroundProcessCleanup(params.session.id);
    }
    scheduleExecSessionCleanup(params.session.id);
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

async function waitForSessionOutput(params: {
  session: ExecSession;
  startOffset: number;
  yieldTimeMs: number;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
}): Promise<{ output: string; wallTimeMs: number }> {
  const startTime = Date.now();
  const deadline = startTime + params.yieldTimeMs;
  let emittedOffset = params.startOffset;

  while (Date.now() < deadline && params.session.status === "running") {
    if (params.onOutput && params.session.output.length > emittedOffset) {
      params.onOutput(params.session.output.slice(emittedOffset), "stdout");
      emittedOffset = params.session.output.length;
    }
    await sleep(25);
  }

  if (params.onOutput && params.session.output.length > emittedOffset) {
    params.onOutput(params.session.output.slice(emittedOffset), "stdout");
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
  const launcher = launchers[0];
  if (!launcher) {
    throw new Error("Command must be a non-empty string");
  }

  const session: ExecSession = {
    id,
    command: args.cmd,
    output: "",
    readOffset: 0,
    status: "running",
    exitCode: null,
    tty: args.tty ?? false,
  };
  execSessions.set(id, session);

  let processLauncher: ProcessLauncher;
  try {
    processLauncher = spawnPipeProcess({
      launcher,
      cwd,
      env,
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
    onOutput: args.onOutput,
  });

  return {
    output: formatExecOutput({
      chunkId: generateChunkId(),
      wallTimeMs,
      exitCode: session.exitCode,
      sessionId: session.status === "running" ? session.id : null,
      output,
      originalTokenCount: estimateTokenCount(output),
      maxOutputTokens: args.max_output_tokens,
    }),
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
    throw new Error(`Unknown unified exec session ID: ${sessionId}`);
  }

  const chars = args.chars ?? "";
  if (chars && !session.tty) {
    throw new Error(
      "stdin is only available for exec_command sessions started with tty=true",
    );
  }
  if (chars) {
    (backgroundProcess.process as ProcessLauncher).write(chars);
    await sleep(100);
  }

  const startOffset = session.readOffset;
  const yieldTimeMs = clampYieldTime(
    args.yield_time_ms,
    DEFAULT_WRITE_STDIN_YIELD_TIME_MS,
  );
  const { output, wallTimeMs } = await waitForSessionOutput({
    session,
    startOffset,
    yieldTimeMs,
    onOutput: args.onOutput,
  });

  return {
    output: formatExecOutput({
      chunkId: generateChunkId(),
      wallTimeMs,
      exitCode: session.exitCode,
      sessionId: session.status === "running" ? session.id : null,
      output,
      originalTokenCount: estimateTokenCount(output),
      maxOutputTokens: args.max_output_tokens,
    }),
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
