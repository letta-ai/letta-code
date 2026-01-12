import { EventEmitter } from "node:events";
import net from "node:net";

export type ActiveOverlay =
  | "model"
  | "toolset"
  | "system"
  | "agent"
  | "resume"
  | "search"
  | "subagent"
  | "feedback"
  | "memory"
  | "pin"
  | "new"
  | "mcp"
  | "help"
  | "oauth"
  | null;

export type UiAction =
  | { type: "overlay.open"; overlay: Exclude<ActiveOverlay, null> }
  | { type: "overlay.close" }
  | { type: "model.select"; modelId: string }
  | { type: "toolset.select"; toolset: string }
  | { type: "system.select"; promptId: string }
  | { type: "agent.select"; agentId: string }
  | { type: "approval.approveCurrent" }
  | { type: "approval.approveAlways"; scope?: "project" | "session" }
  | { type: "approval.denyCurrent"; reason: string }
  | { type: "approval.cancel" };

export type ServerToRunnerMessage =
  | { type: "runner.submit"; text: string }
  | { type: "runner.interrupt" }
  | { type: "runner.ui_action"; action: UiAction }
  | {
      type: "runner.tool_ui.event";
      toolCallId: string;
      event: { type: string; payload?: unknown };
    };

export type RunnerToServerMessage =
  | { type: "runner.ready"; pid: number }
  | { type: "runner.ui_state"; state: unknown }
  | {
      type: "runner.tool_ui.state";
      toolCallId: string;
      toolName: string;
      state: { kind: string; payload: unknown };
    }
  | {
      type: "runner.log";
      level: "debug" | "info" | "warn" | "error";
      message: string;
    };

function encodeNdjson(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function createNdjsonParser(onMessage: (value: unknown) => void) {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) return;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        onMessage(JSON.parse(trimmed));
      } catch {
        // Ignore malformed lines.
      }
    }
  };
}

const socketPath = process.env.LETTA_CODE_WEB_UI_SOCKET;
const emitter = new EventEmitter();

let socket: net.Socket | null = null;

export function webTuiEnabled(): boolean {
  return Boolean(socketPath);
}

export function ensureWebTuiConnected() {
  if (!socketPath || socket) return;

  socket = net.connect(socketPath);
  socket.setEncoding("utf8");

  const parse = createNdjsonParser((msg) => {
    emitter.emit("message", msg);
  });

  socket.on("connect", () => {
    sendToServer({ type: "runner.ready", pid: process.pid });
  });

  socket.on("data", (chunk) => parse(String(chunk)));
  socket.on("error", () => {
    // Best-effort; the CLI should still run in the terminal if the socket isn't available.
  });
}

export function sendToServer(message: RunnerToServerMessage) {
  if (!socket) ensureWebTuiConnected();
  if (!socket) return;
  socket.write(encodeNdjson(message));
}

export function logToServer(
  level: "debug" | "info" | "warn" | "error",
  message: string,
) {
  sendToServer({ type: "runner.log", level, message });
}

export function onServerMessage(
  handler: (msg: ServerToRunnerMessage) => void,
): () => void {
  ensureWebTuiConnected();
  const listener = (msg: unknown) => {
    if (!msg || typeof msg !== "object") return;
    const typed = msg as Partial<ServerToRunnerMessage>;
    if (typed.type === "runner.submit" && typeof typed.text === "string") {
      handler({ type: "runner.submit", text: typed.text });
    } else if (typed.type === "runner.interrupt") {
      handler({ type: "runner.interrupt" });
    } else if (
      typed.type === "runner.ui_action" &&
      (typed as { action?: unknown }).action &&
      typeof (typed as { action?: unknown }).action === "object"
    ) {
      handler({
        type: "runner.ui_action",
        action: (typed as { action: UiAction }).action,
      });
    } else if (
      typed.type === "runner.tool_ui.event" &&
      typeof (typed as { toolCallId?: unknown }).toolCallId === "string" &&
      (typed as { event?: unknown }).event &&
      typeof (typed as { event?: unknown }).event === "object"
    ) {
      handler({
        type: "runner.tool_ui.event",
        toolCallId: (typed as { toolCallId: string }).toolCallId,
        event: (typed as { event: { type: string; payload?: unknown } }).event,
      });
    }
  };

  emitter.on("message", listener);
  return () => emitter.off("message", listener);
}
