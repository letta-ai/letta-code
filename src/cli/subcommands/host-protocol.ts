import type { Readable } from "node:stream";

export const HOST_COMMAND_PREFIX = "LETTA_HOST_COMMAND ";
export const HOST_PROTOCOL_PREFIX = "LETTA_HOST_EVENT ";

export type HostProtocolEvent =
  | {
      version: 1;
      type: "ready";
      connectionId: string;
    }
  | {
      version: 1;
      type: "processing";
      connectionId: string;
    }
  | {
      version: 1;
      type: "reconnecting";
      connectionId: string;
      attempt: number;
      retryInMs: number;
    }
  | {
      version: 1;
      type: "fatal";
      reason: string;
      message: string;
    };

type HostProtocolWriter = (line: string) => void;

export type StdioHostProtocol = {
  emitStatus: (
    status: "idle" | "receiving" | "processing",
    connectionId: string,
  ) => void;
  emitReady: (connectionId: string) => void;
  emitReconnecting: (
    connectionId: string,
    attempt: number,
    retryInMs: number,
  ) => void;
  emitFatal: (reason: string, message: string) => void;
};

const PARENT_WATCH_INTERVAL_MS = 2_000;

/** Listen for the tray's cross-platform graceful-shutdown command. */
export function startStdioHostCommandListener(
  onShutdown: () => void,
  input: Readable = process.stdin,
): () => void {
  let buffer = "";
  let handled = false;
  const onData = (chunk: Buffer | string): void => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (handled || !line.startsWith(HOST_COMMAND_PREFIX)) continue;
      try {
        const command = JSON.parse(
          line.slice(HOST_COMMAND_PREFIX.length),
        ) as unknown;
        if (
          command &&
          typeof command === "object" &&
          "version" in command &&
          command.version === 1 &&
          "type" in command &&
          command.type === "shutdown"
        ) {
          handled = true;
          onShutdown();
        }
      } catch {
        // Ignore non-protocol input.
      }
    }
  };
  input.on("data", onData);
  input.resume();
  return () => {
    input.off("data", onData);
    input.pause();
  };
}

/** Exit a daemon-managed listener when its supervising tray process disappears. */
export function startHostParentWatchdog(
  onParentExit: () => void = () => process.exit(0),
  parentPidValue = process.env.LETTA_DAEMON_PARENT_PID,
): void {
  if (!parentPidValue) return;
  const parentPid = Number(parentPidValue);
  if (!Number.isInteger(parentPid) || parentPid <= 1) {
    throw new Error("LETTA_DAEMON_PARENT_PID must be a valid process ID.");
  }

  const timer = setInterval(() => {
    if (process.ppid === parentPid && isProcessAlive(parentPid)) return;
    clearInterval(timer);
    onParentExit();
  }, PARENT_WATCH_INTERVAL_MS);
  timer.unref();
}

/**
 * Emits a deliberately prefixed JSON line so hosts can identify protocol events
 * while allowing ordinary listener output to remain on stdout.
 */
export function createStdioHostProtocol(
  write: HostProtocolWriter = console.log,
): StdioHostProtocol {
  let lastReadyConnectionId: string | null = null;

  const emit = (event: HostProtocolEvent): void => {
    write(`${HOST_PROTOCOL_PREFIX}${JSON.stringify(event)}`);
  };

  const emitReady = (connectionId: string): void => {
    if (lastReadyConnectionId === connectionId) return;
    lastReadyConnectionId = connectionId;
    emit({ version: 1, type: "ready", connectionId });
  };

  return {
    emitStatus: (status, connectionId) => {
      if (status === "idle") {
        emitReady(connectionId);
      } else if (status === "processing") {
        lastReadyConnectionId = null;
        emit({ version: 1, type: "processing", connectionId });
      }
    },
    emitReady,
    emitReconnecting: (connectionId, attempt, retryInMs) => {
      lastReadyConnectionId = null;
      emit({
        version: 1,
        type: "reconnecting",
        connectionId,
        attempt,
        retryInMs,
      });
    },
    emitFatal: (reason, message) => {
      lastReadyConnectionId = null;
      emit({ version: 1, type: "fatal", reason, message });
    },
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}
