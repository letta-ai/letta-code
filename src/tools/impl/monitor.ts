import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import stripAnsi from "strip-ansi";
import { type RawData, WebSocket } from "ws";
import { getCurrentWorkingDirectory } from "@/runtime-context";
import { scrubSecretsFromString } from "@/tools/secret-substitution";
import { addToMessageQueue } from "@/utils/message-queue-bridge.js";
import {
  formatMonitorEventNotification,
  formatTaskNotification,
  resolveNotificationScope,
} from "@/utils/task-notifications.js";
import { noteExpectedWorktreeForLauncher } from "@/websocket/listener/worktree-ownership";
import { getBackgroundLauncher } from "./bash.js";
import {
  createMonitorEventStream,
  MONITOR_EVENT_BUFFER_CHARS,
} from "./monitor-event-stream.js";
import {
  appendBackgroundProcessOutput,
  assertBackgroundProcessCapacity,
  type BackgroundProcess,
  backgroundProcesses,
  createBackgroundOutputFile,
  getNextMonitorId,
  notifyBackgroundProcessStateChanged,
  scheduleBackgroundProcessCleanup,
  scrubCompletedBackgroundOutput,
  unrefTimer,
} from "./process_manager.js";
import { getShellEnv } from "./shell-env.js";
import { withStrictShellPrelude } from "./shell-launchers.js";
import { startShellProcess } from "./shell-runner.js";
import { applyShellSandbox } from "./shell-sandbox.js";

const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 3_600_000;
const DEFAULT_TIMEOUT_MS = 300_000;
export const MONITOR_OUTPUT_FILE_BYTES = 1024 * 1024;
const WEBSOCKET_MAX_PAYLOAD_BYTES = MONITOR_EVENT_BUFFER_CHARS * 2;
const WEBSOCKET_PROTOCOL_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

interface MonitorWebSocketSource {
  url: string;
  protocols?: string[];
}

interface MonitorArgs {
  description: string;
  timeout_ms?: number;
  persistent?: boolean;
  command?: string;
  ws?: MonitorWebSocketSource;
  secretEnv?: Record<string, string>;
  parentScope?: { agentId: string; conversationId: string };
}

type NormalizedMonitorArgs = MonitorArgs & {
  timeout_ms: number;
  persistent: boolean;
};

interface MonitorResult {
  content: Array<{ type: "text"; text: string }>;
  taskId: string;
  timeoutMs: number;
  persistent: boolean;
}

function buildMonitorResult(
  taskId: string,
  timeoutMs: number,
  persistent: boolean,
): MonitorResult {
  const lifetime = persistent
    ? "persistent — runs until TaskStop or session end"
    : `timeout ${timeoutMs}ms`;
  return {
    content: [
      {
        type: "text",
        text: `Monitor started (task ${taskId}, ${lifetime}). You will be notified on each event. Keep working — do not poll or sleep. Events may arrive while you are waiting for the user — an event is not their reply.`,
      },
    ],
    taskId,
    timeoutMs,
    persistent,
  };
}

function validUtf8Prefix(buffer: Buffer, maxBytes: number): Buffer {
  let end = Math.min(buffer.length, maxBytes);
  while (end > Math.max(0, maxBytes - 4)) {
    const prefix = buffer.subarray(0, end);
    if (Buffer.from(prefix.toString("utf8"), "utf8").equals(prefix)) {
      return prefix;
    }
    end -= 1;
  }
  return buffer.subarray(0, end);
}

class MonitorOutputWriter {
  private bytesWritten = 0;
  private truncated = false;
  private writeFailed = false;

  constructor(private readonly path: string) {}

  append(text: string): boolean {
    if (this.truncated || this.writeFailed || !text) return true;
    const chunk = Buffer.from(text, "utf8");
    const remaining = MONITOR_OUTPUT_FILE_BYTES - this.bytesWritten;
    if (chunk.length <= remaining) {
      try {
        appendFileSync(this.path, chunk);
      } catch {
        this.writeFailed = true;
        return false;
      }
      this.bytesWritten += chunk.length;
      return true;
    }

    const marker = Buffer.from(
      `\n[output truncated at ${MONITOR_OUTPUT_FILE_BYTES} bytes]\n`,
      "utf8",
    );
    try {
      const content = validUtf8Prefix(
        Buffer.concat([readFileSync(this.path), chunk]),
        MONITOR_OUTPUT_FILE_BYTES - marker.length,
      );
      const truncatedOutput = Buffer.concat([content, marker]);
      writeFileSync(this.path, truncatedOutput);
      this.bytesWritten = truncatedOutput.length;
      this.truncated = true;
    } catch {
      this.writeFailed = true;
      return false;
    }
    return true;
  }
}

function containsHiddenControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (
      code !== 9 &&
      code !== 10 &&
      (code < 32 || (code >= 127 && code <= 159))
    ) {
      return true;
    }
  }
  return false;
}

function validateWebSocketSource(source: MonitorWebSocketSource): void {
  if (typeof source.url !== "string") {
    throw new Error("Monitor ws.url must be a string");
  }

  let url: URL;
  try {
    url = new URL(source.url);
  } catch {
    throw new Error("Monitor ws.url must be a valid ws:// or wss:// URL");
  }
  if (
    (url.protocol !== "ws:" && url.protocol !== "wss:") ||
    url.username ||
    url.password ||
    /\s/u.test(source.url) ||
    [...source.url].some((character) => (character.codePointAt(0) ?? 128) > 127)
  ) {
    throw new Error(
      "Monitor ws.url must be an ASCII ws:// or wss:// URL with no embedded credentials or whitespace",
    );
  }

  if (source.protocols === undefined) return;
  if (!Array.isArray(source.protocols)) {
    throw new Error("Monitor ws.protocols must be an array of strings");
  }
  if (
    source.protocols.some(
      (protocol) =>
        typeof protocol !== "string" ||
        !WEBSOCKET_PROTOCOL_PATTERN.test(protocol),
    )
  ) {
    throw new Error("Monitor ws.protocols must contain RFC 6455 tokens");
  }
  if (new Set(source.protocols).size !== source.protocols.length) {
    throw new Error("Monitor ws.protocols must be unique");
  }
}

function normalizeMonitorArgs(args: MonitorArgs): NormalizedMonitorArgs {
  const normalized: NormalizedMonitorArgs = {
    ...args,
    timeout_ms: args.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    persistent: args.persistent ?? false,
  };

  if (typeof normalized.description !== "string") {
    throw new Error("Monitor description is required");
  }
  if (
    typeof normalized.timeout_ms !== "number" ||
    !Number.isFinite(normalized.timeout_ms) ||
    normalized.timeout_ms < MIN_TIMEOUT_MS ||
    (!normalized.persistent && normalized.timeout_ms > MAX_TIMEOUT_MS)
  ) {
    throw new Error(
      `Monitor timeout_ms must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`,
    );
  }
  if (typeof normalized.persistent !== "boolean") {
    throw new Error("Monitor persistent must be a boolean");
  }
  if (
    normalized.command !== undefined &&
    typeof normalized.command !== "string"
  ) {
    throw new Error("Monitor command must be a string");
  }

  // Some tool calls include both source fields with an empty value for the
  // unused one.
  const hasCommand =
    typeof normalized.command === "string" && normalized.command.length > 0;
  const hasWebSocket =
    normalized.ws !== undefined &&
    !(
      typeof normalized.ws === "object" &&
      normalized.ws !== null &&
      normalized.ws.url === ""
    );
  if (Number(hasCommand) + Number(hasWebSocket) !== 1) {
    throw new Error("Monitor requires exactly one of command or ws");
  }
  if (!hasCommand) {
    delete normalized.command;
  }
  if (!hasWebSocket) {
    delete normalized.ws;
  }
  if (
    hasCommand &&
    containsHiddenControlCharacter(normalized.command as string)
  ) {
    throw new Error(
      "Monitor command contains control characters that would be hidden in the approval dialog",
    );
  }
  if (hasWebSocket) {
    if (typeof normalized.ws !== "object" || normalized.ws === null) {
      throw new Error("Monitor ws must be an object");
    }
    validateWebSocketSource(normalized.ws);
  }
  return normalized;
}

function webSocketDisplayUrl(sourceUrl: string): string {
  const url = new URL(sourceUrl);
  url.search = "";
  url.hash = "";
  return url.toString();
}

function getRawDataBytes(data: RawData): number {
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.length, 0);
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  return data.length;
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return data.toString("utf8");
}

function sanitizeMonitorText(
  text: string,
  secrets: Readonly<Record<string, string>>,
): string {
  return stripAnsi(scrubSecretsFromString(text, secrets));
}

function queueMonitorEvent(params: {
  taskId: string;
  description: string;
  event: string;
  scope: ReturnType<typeof resolveNotificationScope>;
  secrets: Readonly<Record<string, string>>;
}): void {
  const { taskId, description, event, scope, secrets } = params;
  const sanitizedEvent = sanitizeMonitorText(event, secrets);
  addToMessageQueue({
    kind: "task_notification",
    text: formatMonitorEventNotification({
      taskId,
      description,
      event: sanitizedEvent,
    }),
    agentId: scope?.agentId,
    conversationId: scope?.conversationId,
  });
}

function queueCommandCompletion(params: {
  taskId: string;
  description: string;
  outputFile: string;
  processState: BackgroundProcess;
  scope: ReturnType<typeof resolveNotificationScope>;
  exitCode: number | null;
}): void {
  const { taskId, description, outputFile, processState, scope, exitCode } =
    params;
  if (processState.completionNotificationSuppressed) return;

  const status = processState.status === "completed" ? "completed" : "failed";
  const producedOutput = (processState.totalStdoutLines ?? 0) > 0;
  const exitSuffix = exitCode === null ? "" : ` (exit ${exitCode})`;
  const summary =
    status === "failed"
      ? `Monitor "${description}" script failed${exitSuffix}`
      : producedOutput
        ? `Monitor "${description}" stream ended`
        : `Monitor "${description}" ended without producing output${exitSuffix}`;
  const durationMs = processState.startTime
    ? Math.max(0, Date.now() - processState.startTime.getTime())
    : undefined;

  addToMessageQueue({
    kind: "task_notification",
    text: formatTaskNotification({
      taskId,
      status,
      summary,
      result:
        exitCode === null
          ? "The monitor ended before returning an exit code."
          : `Exit code: ${exitCode}`,
      outputFile,
      usage: durationMs === undefined ? undefined : { durationMs },
    }),
    agentId: scope?.agentId,
    conversationId: scope?.conversationId,
  });
}

function markMonitorFinished(
  taskId: string,
  processState: BackgroundProcess,
  status: "completed" | "failed",
  exitCode: number | null,
): void {
  processState.status = status;
  processState.exitCode = exitCode;
  scrubCompletedBackgroundOutput(processState);
  notifyBackgroundProcessStateChanged(processState.runtimeScope);
  scheduleBackgroundProcessCleanup(taskId);
}

function startCommandMonitor(args: NormalizedMonitorArgs): MonitorResult {
  assertBackgroundProcessCapacity();
  const command = args.command as string;
  const cwd = getCurrentWorkingDirectory();
  const env = args.secretEnv
    ? { ...getShellEnv(), ...args.secretEnv }
    : getShellEnv();
  const commandToRun = withStrictShellPrelude(command, env);
  const launcher = getBackgroundLauncher(commandToRun, env, args.secretEnv);
  if (!launcher[0]) {
    throw new Error("No shell available");
  }
  noteExpectedWorktreeForLauncher(launcher, cwd);
  const sandboxed = applyShellSandbox(launcher, cwd, env);
  const taskId = getNextMonitorId();
  const outputFile = createBackgroundOutputFile(taskId);
  const output = new MonitorOutputWriter(outputFile);
  const scope = resolveNotificationScope(args.parentScope);
  const secrets = args.secretEnv ?? {};
  let processState: BackgroundProcess;

  const events = createMonitorEventStream({
    emit(event) {
      queueMonitorEvent({
        taskId,
        description: args.description,
        event,
        scope,
        secrets,
      });
    },
    stopSource() {
      if (!processState || processState.status !== "running") return;
      processState.completionNotificationSuppressed = true;
      output.append("\n[stopped: output rate too high]\n");
      markMonitorFinished(taskId, processState, "failed", null);
      processState.process.kill("SIGTERM");
    },
  });

  const runningProcess = startShellProcess(sandboxed.launcher, {
    cwd,
    env: sandboxed.env,
    timeoutMs: args.persistent ? 0 : args.timeout_ms,
    sourceCommand: command,
    captureOutput: false,
    onOutput(text, stream) {
      if (!processState) return;
      const sanitizedText = sanitizeMonitorText(text, secrets);
      appendBackgroundProcessOutput(processState, stream, sanitizedText);
      const wrote = output.append(
        stream === "stderr" ? `[stderr] ${sanitizedText}` : sanitizedText,
      );
      if (!wrote && processState.status === "running") {
        appendBackgroundProcessOutput(
          processState,
          "stderr",
          "[output file write failed; output may be incomplete]",
        );
        processState.completionNotificationSuppressed = true;
        markMonitorFinished(taskId, processState, "failed", null);
        try {
          runningProcess.process.kill("SIGTERM");
        } catch {
          // Process may have already exited.
        }
        return;
      }
      if (stream === "stdout") {
        events.onData(sanitizedText);
      }
    },
  });

  processState = {
    process: {
      kill(signal) {
        events.cancel();
        if (signal === "SIGKILL") {
          runningProcess.process.kill("SIGKILL");
          return;
        }
        runningProcess.terminate();
      },
    },
    command,
    stdout: [],
    stderr: [],
    status: "running",
    exitCode: null,
    lastReadIndex: { stdout: 0, stderr: 0 },
    startTime: new Date(),
    outputFile,
    totalStdoutLines: 0,
    totalStderrLines: 0,
    runtimeScope: scope,
    kind: "monitor",
    description: args.description,
    monitorSource: "command",
    persistent: args.persistent,
    secrets,
  };
  backgroundProcesses.set(taskId, processState);
  notifyBackgroundProcessStateChanged(scope);

  void runningProcess.completion.then(
    ({ exitCode }) => {
      if (backgroundProcesses.get(taskId) !== processState) return;
      events.finish();
      output.append(`\n[exit code: ${exitCode}]\n`);
      if (processState.status !== "running") return;
      markMonitorFinished(
        taskId,
        processState,
        exitCode === 0 ? "completed" : "failed",
        exitCode,
      );
      queueCommandCompletion({
        taskId,
        description: args.description,
        outputFile,
        processState,
        scope,
        exitCode,
      });
    },
    (error: unknown) => {
      if (backgroundProcesses.get(taskId) !== processState) return;
      events.finish();
      if (processState.status !== "running") return;
      const shellError = error as Error & { killed?: boolean };
      if (shellError.killed) {
        output.append(`\n[timeout after ${args.timeout_ms}ms]\n`);
        queueMonitorEvent({
          taskId,
          description: args.description,
          event: "[Monitor timed out — re-arm if needed.]",
          scope,
          secrets,
        });
        processState.completionNotificationSuppressed = true;
      } else {
        const message = sanitizeMonitorText(
          shellError.message || String(error),
          secrets,
        );
        appendBackgroundProcessOutput(processState, "stderr", message);
        output.append(`\n[error] ${message}\n`);
      }
      markMonitorFinished(taskId, processState, "failed", null);
      if (!shellError.killed) {
        queueCommandCompletion({
          taskId,
          description: args.description,
          outputFile,
          processState,
          scope,
          exitCode: null,
        });
      }
    },
  );

  return buildMonitorResult(
    taskId,
    args.persistent ? 0 : args.timeout_ms,
    args.persistent,
  );
}

function startWebSocketMonitor(args: NormalizedMonitorArgs): MonitorResult {
  assertBackgroundProcessCapacity();
  const source = args.ws as MonitorWebSocketSource;
  const taskId = getNextMonitorId();
  const outputFile = createBackgroundOutputFile(taskId);
  const output = new MonitorOutputWriter(outputFile);
  const scope = resolveNotificationScope(args.parentScope);
  const secrets: Readonly<Record<string, string>> = {};
  const socket = new WebSocket(source.url, source.protocols, {
    maxPayload: WEBSOCKET_MAX_PAYLOAD_BYTES,
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let sawSocketError = false;
  let processState: BackgroundProcess;

  const closeSocket = (): void => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }
    try {
      socket.terminate();
    } catch {
      // The socket is already closed.
    }
  };

  const events = createMonitorEventStream({
    emit(event) {
      queueMonitorEvent({
        taskId,
        description: args.description,
        event,
        scope,
        secrets,
      });
    },
    stopSource() {
      if (!processState || processState.status !== "running") return;
      processState.completionNotificationSuppressed = true;
      output.append("\n[stopped: output rate too high]\n");
      markMonitorFinished(taskId, processState, "failed", null);
      closeSocket();
    },
  });

  processState = {
    process: {
      kill() {
        events.cancel();
        closeSocket();
      },
    },
    command: webSocketDisplayUrl(source.url),
    stdout: [],
    stderr: [],
    status: "running",
    exitCode: null,
    lastReadIndex: { stdout: 0, stderr: 0 },
    startTime: new Date(),
    outputFile,
    totalStdoutLines: 0,
    totalStderrLines: 0,
    runtimeScope: scope,
    kind: "monitor",
    description: args.description,
    monitorSource: "websocket",
    persistent: args.persistent,
    secrets,
  };
  backgroundProcesses.set(taskId, processState);
  notifyBackgroundProcessStateChanged(scope);

  socket.on("message", (data, isBinary) => {
    if (
      backgroundProcesses.get(taskId) !== processState ||
      processState.status !== "running"
    ) {
      return;
    }
    const byteLength = getRawDataBytes(data);
    if (byteLength > MONITOR_EVENT_BUFFER_CHARS) {
      events.finish();
      if (processState.status !== "running") return;
      const event = `[Dropped ${byteLength}-byte frame (exceeds ${MONITOR_EVENT_BUFFER_CHARS}); closing]`;
      output.append(`${event}\n`);
      queueMonitorEvent({
        taskId,
        description: args.description,
        event,
        scope,
        secrets,
      });
      processState.completionNotificationSuppressed = true;
      markMonitorFinished(taskId, processState, "failed", null);
      closeSocket();
      return;
    }

    const text = sanitizeMonitorText(
      isBinary ? `[binary frame, ${byteLength} bytes]` : rawDataToString(data),
      secrets,
    );
    appendBackgroundProcessOutput(processState, "stdout", text);
    const wrote = output.append(`${text}\n`);
    if (!wrote) {
      appendBackgroundProcessOutput(
        processState,
        "stderr",
        "[output file write failed; output may be incomplete]",
      );
      processState.completionNotificationSuppressed = true;
      markMonitorFinished(taskId, processState, "failed", null);
      closeSocket();
      return;
    }
    events.onData(`${text}\n`);
  });

  socket.on("error", (error) => {
    if (
      backgroundProcesses.get(taskId) !== processState ||
      processState.status !== "running"
    ) {
      return;
    }
    sawSocketError = true;
    const message = sanitizeMonitorText(error.message, secrets);
    const event = `[WebSocket error: ${message}]`;
    appendBackgroundProcessOutput(processState, "stderr", message);
    output.append(`[stderr] ${message}\n`);
    queueMonitorEvent({
      taskId,
      description: args.description,
      event,
      scope,
      secrets,
    });
    closeSocket();
  });

  socket.on("close", (code, reason) => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }
    if (
      backgroundProcesses.get(taskId) !== processState ||
      processState.status !== "running"
    ) {
      return;
    }
    events.finish();
    if (processState.status !== "running") return;
    const closeReason = sanitizeMonitorText(reason.toString("utf8"), secrets);
    const reasonSuffix = closeReason ? ` ${closeReason}` : "";
    const event = `[WebSocket closed: ${code}${reasonSuffix}]`;
    output.append(`${event}\n`);
    queueMonitorEvent({
      taskId,
      description: args.description,
      event,
      scope,
      secrets,
    });
    markMonitorFinished(
      taskId,
      processState,
      code === 1000 && !sawSocketError ? "completed" : "failed",
      code,
    );
  });

  if (!args.persistent) {
    timeout = setTimeout(() => {
      if (processState.status !== "running") return;
      events.finish();
      if (processState.status !== "running") return;
      queueMonitorEvent({
        taskId,
        description: args.description,
        event: "[Monitor timed out — re-arm if needed.]",
        scope,
        secrets,
      });
      output.append(`\n[timeout after ${args.timeout_ms}ms]\n`);
      processState.completionNotificationSuppressed = true;
      markMonitorFinished(taskId, processState, "failed", null);
      closeSocket();
    }, args.timeout_ms);
    unrefTimer(timeout);
  }

  return buildMonitorResult(
    taskId,
    args.persistent ? 0 : args.timeout_ms,
    args.persistent,
  );
}

export async function monitor(args: MonitorArgs): Promise<MonitorResult> {
  const normalized = normalizeMonitorArgs(args);
  installMonitorProcessExitCleanup();
  return normalized.command !== undefined
    ? startCommandMonitor(normalized)
    : startWebSocketMonitor(normalized);
}

export function stopMonitorsForProcessExit(): void {
  for (const processState of backgroundProcesses.values()) {
    if (processState.kind !== "monitor" || processState.status !== "running") {
      continue;
    }
    processState.completionNotificationSuppressed = true;
    processState.status = "failed";
    try {
      processState.process.kill("SIGKILL");
    } catch {
      // Process exit is already underway.
    }
  }
}

let monitorProcessExitCleanupInstalled = false;

function installMonitorProcessExitCleanup(): void {
  if (monitorProcessExitCleanupInstalled) return;
  monitorProcessExitCleanupInstalled = true;
  process.once("exit", stopMonitorsForProcessExit);
}
