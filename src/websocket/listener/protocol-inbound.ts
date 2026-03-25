import type WebSocket from "ws";
import type {
  AbortMessageCommand,
  ChangeDeviceStateCommand,
  EnableMemfsCommand,
  InputCommand,
  ListInDirectoryCommand,
  ListMemoryCommand,
  ReadFileCommand,
  RuntimeScope,
  SearchFilesCommand,
  SyncCommand,
  TerminalInputCommand,
  TerminalKillCommand,
  TerminalResizeCommand,
  TerminalSpawnCommand,
  WsProtocolCommand,
} from "../../types/protocol_v2";
import { isValidApprovalResponseBody } from "./approval";
import type { InvalidInputCommand, ParsedServerMessage } from "./types";

function isRuntimeScope(value: unknown): value is RuntimeScope {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { agent_id?: unknown; conversation_id?: unknown };
  return (
    typeof candidate.agent_id === "string" &&
    candidate.agent_id.length > 0 &&
    typeof candidate.conversation_id === "string" &&
    candidate.conversation_id.length > 0
  );
}

function isInputCommand(value: unknown): value is InputCommand {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as {
    type?: unknown;
    runtime?: unknown;
    payload?: unknown;
  };
  if (candidate.type !== "input" || !isRuntimeScope(candidate.runtime)) {
    return false;
  }
  if (!candidate.payload || typeof candidate.payload !== "object") {
    return false;
  }

  const payload = candidate.payload as {
    kind?: unknown;
    messages?: unknown;
    request_id?: unknown;
    decision?: unknown;
    error?: unknown;
  };
  if (payload.kind === "create_message") {
    return Array.isArray(payload.messages);
  }
  if (payload.kind === "approval_response") {
    return isValidApprovalResponseBody(payload);
  }
  return false;
}

function getInvalidInputReason(value: unknown): {
  runtime: RuntimeScope;
  reason: string;
} | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as {
    type?: unknown;
    runtime?: unknown;
    payload?: unknown;
  };
  if (candidate.type !== "input" || !isRuntimeScope(candidate.runtime)) {
    return null;
  }
  if (!candidate.payload || typeof candidate.payload !== "object") {
    return {
      runtime: candidate.runtime,
      reason: "Protocol violation: input.payload must be an object",
    };
  }
  const payload = candidate.payload as {
    kind?: unknown;
    messages?: unknown;
    request_id?: unknown;
    decision?: unknown;
    error?: unknown;
  };
  if (payload.kind === "create_message") {
    if (!Array.isArray(payload.messages)) {
      return {
        runtime: candidate.runtime,
        reason:
          "Protocol violation: input.kind=create_message requires payload.messages[]",
      };
    }
    return null;
  }
  if (payload.kind === "approval_response") {
    if (!isValidApprovalResponseBody(payload)) {
      return {
        runtime: candidate.runtime,
        reason:
          "Protocol violation: input.kind=approval_response requires payload.request_id and either payload.decision or payload.error",
      };
    }
    return null;
  }
  return {
    runtime: candidate.runtime,
    reason: `Unsupported input payload kind: ${String(payload.kind)}`,
  };
}

function isChangeDeviceStateCommand(
  value: unknown,
): value is ChangeDeviceStateCommand {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as {
    type?: unknown;
    runtime?: unknown;
    payload?: unknown;
  };
  if (
    candidate.type !== "change_device_state" ||
    !isRuntimeScope(candidate.runtime)
  ) {
    return false;
  }
  if (!candidate.payload || typeof candidate.payload !== "object") {
    return false;
  }
  const payload = candidate.payload as {
    mode?: unknown;
    cwd?: unknown;
    agent_id?: unknown;
    conversation_id?: unknown;
  };
  const hasMode =
    payload.mode === undefined || typeof payload.mode === "string";
  const hasCwd = payload.cwd === undefined || typeof payload.cwd === "string";
  const hasAgentId =
    payload.agent_id === undefined ||
    payload.agent_id === null ||
    typeof payload.agent_id === "string";
  const hasConversationId =
    payload.conversation_id === undefined ||
    payload.conversation_id === null ||
    typeof payload.conversation_id === "string";
  return hasMode && hasCwd && hasAgentId && hasConversationId;
}

function isAbortMessageCommand(value: unknown): value is AbortMessageCommand {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as {
    type?: unknown;
    runtime?: unknown;
    request_id?: unknown;
    run_id?: unknown;
  };
  if (
    candidate.type !== "abort_message" ||
    !isRuntimeScope(candidate.runtime)
  ) {
    return false;
  }
  const hasRequestId =
    candidate.request_id === undefined ||
    typeof candidate.request_id === "string";
  const hasRunId =
    candidate.run_id === undefined ||
    candidate.run_id === null ||
    typeof candidate.run_id === "string";
  return hasRequestId && hasRunId;
}

function isSyncCommand(value: unknown): value is SyncCommand {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as {
    type?: unknown;
    runtime?: unknown;
  };
  return candidate.type === "sync" && isRuntimeScope(candidate.runtime);
}

function isTerminalSpawnCommand(value: unknown): value is TerminalSpawnCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    terminal_id?: unknown;
    cols?: unknown;
    rows?: unknown;
  };
  return (
    c.type === "terminal_spawn" &&
    typeof c.terminal_id === "string" &&
    typeof c.cols === "number" &&
    typeof c.rows === "number"
  );
}

function isTerminalInputCommand(value: unknown): value is TerminalInputCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as { type?: unknown; terminal_id?: unknown; data?: unknown };
  return (
    c.type === "terminal_input" &&
    typeof c.terminal_id === "string" &&
    typeof c.data === "string"
  );
}

function isTerminalResizeCommand(
  value: unknown,
): value is TerminalResizeCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    terminal_id?: unknown;
    cols?: unknown;
    rows?: unknown;
  };
  return (
    c.type === "terminal_resize" &&
    typeof c.terminal_id === "string" &&
    typeof c.cols === "number" &&
    typeof c.rows === "number"
  );
}

function isTerminalKillCommand(value: unknown): value is TerminalKillCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as { type?: unknown; terminal_id?: unknown };
  return c.type === "terminal_kill" && typeof c.terminal_id === "string";
}

export function isSearchFilesCommand(
  value: unknown,
): value is SearchFilesCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as { type?: unknown; query?: unknown; request_id?: unknown };
  return (
    c.type === "search_files" &&
    typeof c.query === "string" &&
    typeof c.request_id === "string"
  );
}

export function isListInDirectoryCommand(
  value: unknown,
): value is ListInDirectoryCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as { type?: unknown; path?: unknown };
  return c.type === "list_in_directory" && typeof c.path === "string";
}

export function isReadFileCommand(value: unknown): value is ReadFileCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as { type?: unknown; path?: unknown; request_id?: unknown };
  return (
    c.type === "read_file" &&
    typeof c.path === "string" &&
    typeof c.request_id === "string"
  );
}

export function isListMemoryCommand(
  value: unknown,
): value is ListMemoryCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    agent_id?: unknown;
  };
  return (
    c.type === "list_memory" &&
    typeof c.request_id === "string" &&
    typeof c.agent_id === "string"
  );
}

export function isEnableMemfsCommand(
  value: unknown,
): value is EnableMemfsCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    agent_id?: unknown;
  };
  return (
    c.type === "enable_memfs" &&
    typeof c.request_id === "string" &&
    typeof c.agent_id === "string"
  );
}

export function parseServerMessage(
  data: WebSocket.RawData,
): ParsedServerMessage | null {
  try {
    const raw = typeof data === "string" ? data : data.toString();
    const parsed = JSON.parse(raw) as unknown;
    if (
      isInputCommand(parsed) ||
      isChangeDeviceStateCommand(parsed) ||
      isAbortMessageCommand(parsed) ||
      isSyncCommand(parsed) ||
      isTerminalSpawnCommand(parsed) ||
      isTerminalInputCommand(parsed) ||
      isTerminalResizeCommand(parsed) ||
      isTerminalKillCommand(parsed) ||
      isSearchFilesCommand(parsed) ||
      isListInDirectoryCommand(parsed) ||
      isReadFileCommand(parsed) ||
      isListMemoryCommand(parsed) ||
      isEnableMemfsCommand(parsed)
    ) {
      return parsed as WsProtocolCommand;
    }
    const invalidInput = getInvalidInputReason(parsed);
    if (invalidInput) {
      const invalidMessage: InvalidInputCommand = {
        type: "__invalid_input",
        runtime: invalidInput.runtime,
        reason: invalidInput.reason,
      };
      return invalidMessage;
    }
    return null;
  } catch {
    return null;
  }
}
