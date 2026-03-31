import type WebSocket from "ws";
import type {
  AbortMessageCommand,
  ChangeDeviceStateCommand,
  CheckoutBranchCommand,
  CronAddCommand,
  CronDeleteAllCommand,
  CronDeleteCommand,
  CronGetCommand,
  CronListCommand,
  EditFileCommand,
  EnableMemfsCommand,
  ExecuteCommandCommand,
  GetReflectionSettingsCommand,
  InputCommand,
  ListInDirectoryCommand,
  ListMemoryCommand,
  ListModelsCommand,
  ReadFileCommand,
  RuntimeScope,
  SearchBranchesCommand,
  SearchFilesCommand,
  SetReflectionSettingsCommand,
  SkillDisableCommand,
  SkillEnableCommand,
  SyncCommand,
  TerminalInputCommand,
  TerminalKillCommand,
  TerminalResizeCommand,
  TerminalSpawnCommand,
  UpdateModelCommand,
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

export function isEditFileCommand(value: unknown): value is EditFileCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    file_path?: unknown;
    old_string?: unknown;
    new_string?: unknown;
    replace_all?: unknown;
    expected_replacements?: unknown;
    request_id?: unknown;
  };
  return (
    c.type === "edit_file" &&
    typeof c.file_path === "string" &&
    typeof c.old_string === "string" &&
    typeof c.new_string === "string" &&
    typeof c.request_id === "string" &&
    (c.replace_all === undefined || typeof c.replace_all === "boolean") &&
    (c.expected_replacements === undefined ||
      (typeof c.expected_replacements === "number" &&
        Number.isInteger(c.expected_replacements) &&
        c.expected_replacements > 0))
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

export function isListModelsCommand(
  value: unknown,
): value is ListModelsCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
  };
  return c.type === "list_models" && typeof c.request_id === "string";
}

export function isUpdateModelCommand(
  value: unknown,
): value is UpdateModelCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    runtime?: unknown;
    payload?: unknown;
  };

  if (
    c.type !== "update_model" ||
    typeof c.request_id !== "string" ||
    !isRuntimeScope(c.runtime) ||
    !c.payload ||
    typeof c.payload !== "object"
  ) {
    return false;
  }

  const payload = c.payload as {
    model_id?: unknown;
    model_handle?: unknown;
  };
  const hasModelId =
    payload.model_id === undefined || typeof payload.model_id === "string";
  const hasModelHandle =
    payload.model_handle === undefined ||
    typeof payload.model_handle === "string";
  const hasAtLeastOne =
    typeof payload.model_id === "string" ||
    typeof payload.model_handle === "string";

  return hasModelId && hasModelHandle && hasAtLeastOne;
}

export function isCronListCommand(value: unknown): value is CronListCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    agent_id?: unknown;
    conversation_id?: unknown;
  };
  return (
    c.type === "cron_list" &&
    typeof c.request_id === "string" &&
    (c.agent_id === undefined || typeof c.agent_id === "string") &&
    (c.conversation_id === undefined || typeof c.conversation_id === "string")
  );
}

export function isCronAddCommand(value: unknown): value is CronAddCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    agent_id?: unknown;
    conversation_id?: unknown;
    name?: unknown;
    description?: unknown;
    cron?: unknown;
    timezone?: unknown;
    recurring?: unknown;
    prompt?: unknown;
    scheduled_for?: unknown;
  };
  return (
    c.type === "cron_add" &&
    typeof c.request_id === "string" &&
    typeof c.agent_id === "string" &&
    (c.conversation_id === undefined ||
      typeof c.conversation_id === "string") &&
    typeof c.name === "string" &&
    typeof c.description === "string" &&
    typeof c.cron === "string" &&
    (c.timezone === undefined || typeof c.timezone === "string") &&
    typeof c.recurring === "boolean" &&
    typeof c.prompt === "string" &&
    (c.scheduled_for === undefined ||
      c.scheduled_for === null ||
      typeof c.scheduled_for === "string")
  );
}

export function isCronGetCommand(value: unknown): value is CronGetCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    task_id?: unknown;
  };
  return (
    c.type === "cron_get" &&
    typeof c.request_id === "string" &&
    typeof c.task_id === "string"
  );
}

export function isCronDeleteCommand(
  value: unknown,
): value is CronDeleteCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    task_id?: unknown;
  };
  return (
    c.type === "cron_delete" &&
    typeof c.request_id === "string" &&
    typeof c.task_id === "string"
  );
}

export function isCronDeleteAllCommand(
  value: unknown,
): value is CronDeleteAllCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    agent_id?: unknown;
  };
  return (
    c.type === "cron_delete_all" &&
    typeof c.request_id === "string" &&
    typeof c.agent_id === "string"
  );
}

export function isSkillEnableCommand(
  value: unknown,
): value is SkillEnableCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    skill_path?: unknown;
  };
  return (
    c.type === "skill_enable" &&
    typeof c.request_id === "string" &&
    typeof c.skill_path === "string"
  );
}

export function isSkillDisableCommand(
  value: unknown,
): value is SkillDisableCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    name?: unknown;
  };
  return (
    c.type === "skill_disable" &&
    typeof c.request_id === "string" &&
    typeof c.name === "string"
  );
}

export function isGetReflectionSettingsCommand(
  value: unknown,
): value is GetReflectionSettingsCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    runtime?: unknown;
  };
  return (
    c.type === "get_reflection_settings" &&
    typeof c.request_id === "string" &&
    isRuntimeScope(c.runtime)
  );
}

export function isSetReflectionSettingsCommand(
  value: unknown,
): value is SetReflectionSettingsCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    runtime?: unknown;
    settings?: unknown;
    scope?: unknown;
  };
  if (
    c.type !== "set_reflection_settings" ||
    typeof c.request_id !== "string" ||
    !isRuntimeScope(c.runtime) ||
    !c.settings ||
    typeof c.settings !== "object"
  ) {
    return false;
  }
  const settings = c.settings as {
    trigger?: unknown;
    step_count?: unknown;
  };
  return (
    (settings.trigger === "off" ||
      settings.trigger === "step-count" ||
      settings.trigger === "compaction-event") &&
    typeof settings.step_count === "number" &&
    Number.isInteger(settings.step_count) &&
    settings.step_count > 0 &&
    (c.scope === undefined ||
      c.scope === "local_project" ||
      c.scope === "global" ||
      c.scope === "both")
  );
}

export function isSearchBranchesCommand(
  value: unknown,
): value is SearchBranchesCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    query?: unknown;
  };
  return (
    c.type === "search_branches" &&
    typeof c.request_id === "string" &&
    typeof c.query === "string"
  );
}

export function isCheckoutBranchCommand(
  value: unknown,
): value is CheckoutBranchCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    branch?: unknown;
  };
  return (
    c.type === "checkout_branch" &&
    typeof c.request_id === "string" &&
    typeof c.branch === "string"
  );
}

export function isExecuteCommandCommand(
  value: unknown,
): value is ExecuteCommandCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    command_id?: unknown;
    request_id?: unknown;
    runtime?: unknown;
  };
  return (
    c.type === "execute_command" &&
    typeof c.command_id === "string" &&
    typeof c.request_id === "string" &&
    isRuntimeScope(c.runtime)
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
      isEditFileCommand(parsed) ||
      isListMemoryCommand(parsed) ||
      isEnableMemfsCommand(parsed) ||
      isListModelsCommand(parsed) ||
      isUpdateModelCommand(parsed) ||
      isCronListCommand(parsed) ||
      isCronAddCommand(parsed) ||
      isCronGetCommand(parsed) ||
      isCronDeleteCommand(parsed) ||
      isCronDeleteAllCommand(parsed) ||
      isSkillEnableCommand(parsed) ||
      isSkillDisableCommand(parsed) ||
      isGetReflectionSettingsCommand(parsed) ||
      isSetReflectionSettingsCommand(parsed) ||
      isExecuteCommandCommand(parsed) ||
      isSearchBranchesCommand(parsed) ||
      isCheckoutBranchCommand(parsed)
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
