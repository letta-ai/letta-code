import type WebSocket from "ws";
import { isValidChannelPluginConfigPayload } from "../../channels/accountConfig";
import type {
  AbortMessageCommand,
  ChangeDeviceStateCommand,
  ChannelAccountBindCommand,
  ChannelAccountCreateCommand,
  ChannelAccountDeleteCommand,
  ChannelAccountStartCommand,
  ChannelAccountStopCommand,
  ChannelAccountsListCommand,
  ChannelAccountUnbindCommand,
  ChannelAccountUpdateCommand,
  ChannelGetConfigCommand,
  ChannelPairingBindCommand,
  ChannelPairingsListCommand,
  ChannelRouteRemoveCommand,
  ChannelRoutesListCommand,
  ChannelRouteUpdateCommand,
  ChannelSetConfigCommand,
  ChannelStartCommand,
  ChannelStopCommand,
  ChannelsListCommand,
  ChannelTargetBindCommand,
  ChannelTargetsListCommand,
  CheckoutBranchCommand,
  CreateAgentCommand,
  CronAddCommand,
  CronDeleteAllCommand,
  CronDeleteCommand,
  CronGetCommand,
  CronListCommand,
  EditFileCommand,
  EnableMemfsCommand,
  ExecuteCommandCommand,
  FileOpsCommand,
  GetExperimentsCommand,
  GetReflectionSettingsCommand,
  GetTreeCommand,
  GrepInFilesCommand,
  InputCommand,
  ListInDirectoryCommand,
  ListMemoryCommand,
  ListModelsCommand,
  MemoryCommitDiffCommand,
  MemoryFileAtRefCommand,
  MemoryHistoryCommand,
  ReadFileCommand,
  RuntimeScope,
  SearchBranchesCommand,
  SearchFilesCommand,
  SetExperimentCommand,
  SetReflectionSettingsCommand,
  SkillDisableCommand,
  SkillEnableCommand,
  SyncCommand,
  TerminalInputCommand,
  TerminalKillCommand,
  TerminalResizeCommand,
  TerminalSpawnCommand,
  UnwatchFileCommand,
  UpdateModelCommand,
  UpdateToolsetCommand,
  WatchFileCommand,
  WriteFileCommand,
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
    recover_approvals?: unknown;
  };
  return (
    candidate.type === "sync" &&
    isRuntimeScope(candidate.runtime) &&
    (candidate.recover_approvals === undefined ||
      typeof candidate.recover_approvals === "boolean")
  );
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

export function isGrepInFilesCommand(
  value: unknown,
): value is GrepInFilesCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as { type?: unknown; query?: unknown; request_id?: unknown };
  return (
    c.type === "grep_in_files" &&
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

export function isGetTreeCommand(value: unknown): value is GetTreeCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    path?: unknown;
    depth?: unknown;
    request_id?: unknown;
  };
  return (
    c.type === "get_tree" &&
    typeof c.path === "string" &&
    typeof c.depth === "number" &&
    typeof c.request_id === "string"
  );
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

export function isWriteFileCommand(value: unknown): value is WriteFileCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    path?: unknown;
    content?: unknown;
    request_id?: unknown;
  };
  return (
    c.type === "write_file" &&
    typeof c.path === "string" &&
    typeof c.content === "string" &&
    typeof c.request_id === "string"
  );
}

export function isWatchFileCommand(value: unknown): value is WatchFileCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as { type?: unknown; path?: unknown; request_id?: unknown };
  return (
    c.type === "watch_file" &&
    typeof c.path === "string" &&
    typeof c.request_id === "string"
  );
}

export function isUnwatchFileCommand(
  value: unknown,
): value is UnwatchFileCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as { type?: unknown; path?: unknown; request_id?: unknown };
  return (
    c.type === "unwatch_file" &&
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

export function isFileOpsCommand(value: unknown): value is FileOpsCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    path?: unknown;
    cg_entries?: unknown;
    ops?: unknown;
    source?: unknown;
  };
  return (
    c.type === "file_ops" &&
    typeof c.path === "string" &&
    Array.isArray(c.cg_entries) &&
    Array.isArray(c.ops) &&
    typeof c.source === "string"
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
    include_references?: unknown;
  };
  return (
    c.type === "list_memory" &&
    typeof c.request_id === "string" &&
    typeof c.agent_id === "string" &&
    (c.include_references === undefined ||
      typeof c.include_references === "boolean")
  );
}

export function isMemoryHistoryCommand(
  value: unknown,
): value is MemoryHistoryCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    agent_id?: unknown;
    file_path?: unknown;
  };
  return (
    c.type === "memory_history" &&
    typeof c.request_id === "string" &&
    typeof c.agent_id === "string" &&
    (c.file_path === undefined || typeof c.file_path === "string")
  );
}

export function isMemoryCommitDiffCommand(
  value: unknown,
): value is MemoryCommitDiffCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    agent_id?: unknown;
    sha?: unknown;
  };
  return (
    c.type === "memory_commit_diff" &&
    typeof c.request_id === "string" &&
    typeof c.agent_id === "string" &&
    typeof c.sha === "string"
  );
}

export function isMemoryFileAtRefCommand(
  value: unknown,
): value is MemoryFileAtRefCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    agent_id?: unknown;
    file_path?: unknown;
    ref?: unknown;
  };
  return (
    c.type === "memory_file_at_ref" &&
    typeof c.request_id === "string" &&
    typeof c.agent_id === "string" &&
    typeof c.file_path === "string" &&
    typeof c.ref === "string"
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

export function isUpdateToolsetCommand(
  value: unknown,
): value is UpdateToolsetCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    runtime?: unknown;
    toolset_preference?: unknown;
  };
  return (
    c.type === "update_toolset" &&
    typeof c.request_id === "string" &&
    isRuntimeScope(c.runtime) &&
    typeof c.toolset_preference === "string"
  );
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

export function isCreateAgentCommand(
  value: unknown,
): value is CreateAgentCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    personality?: unknown;
    model?: unknown;
    pin_global?: unknown;
  };
  return (
    c.type === "create_agent" &&
    typeof c.request_id === "string" &&
    (c.personality === "memo" ||
      c.personality === "linus" ||
      c.personality === "kawaii") &&
    (c.model === undefined || typeof c.model === "string") &&
    (c.pin_global === undefined || typeof c.pin_global === "boolean")
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

export function isGetExperimentsCommand(
  value: unknown,
): value is GetExperimentsCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
  };
  return c.type === "get_experiments" && typeof c.request_id === "string";
}

export function isSetExperimentCommand(
  value: unknown,
): value is SetExperimentCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    experiment_id?: unknown;
    enabled?: unknown;
  };
  return (
    c.type === "set_experiment" &&
    typeof c.request_id === "string" &&
    c.experiment_id === "node" &&
    typeof c.enabled === "boolean"
  );
}

function isChannelId(
  value: unknown,
): value is "telegram" | "slack" | "discord" {
  return value === "telegram" || value === "slack" || value === "discord";
}

function hasValidChannelPolicyFields(config: Record<string, unknown>): boolean {
  const hasValidDmPolicy =
    config.dm_policy === undefined ||
    config.dm_policy === "pairing" ||
    config.dm_policy === "allowlist" ||
    config.dm_policy === "open";
  const hasValidAllowedUsers =
    config.allowed_users === undefined ||
    (Array.isArray(config.allowed_users) &&
      config.allowed_users.every((entry) => typeof entry === "string"));
  const hasValidDisplayName =
    config.display_name === undefined ||
    typeof config.display_name === "string";
  const hasValidEnabled =
    config.enabled === undefined || typeof config.enabled === "boolean";

  return (
    hasValidDmPolicy &&
    hasValidAllowedUsers &&
    hasValidDisplayName &&
    hasValidEnabled
  );
}

function hasOnlyFields(
  value: Record<string, unknown>,
  allowedFields: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((field) => allowedFields.has(field));
}

const CHANNEL_ACCOUNT_CREATE_FIELDS = new Set([
  "account_id",
  "display_name",
  "enabled",
  "dm_policy",
  "allowed_users",
  "config",
]);

const CHANNEL_ACCOUNT_UPDATE_FIELDS = new Set([
  "display_name",
  "enabled",
  "dm_policy",
  "allowed_users",
  "config",
]);

const CHANNEL_SET_CONFIG_FIELDS = new Set([
  "dm_policy",
  "allowed_users",
  "plugin_config",
]);

export function isChannelsListCommand(
  value: unknown,
): value is ChannelsListCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as { type?: unknown; request_id?: unknown };
  return c.type === "channels_list" && typeof c.request_id === "string";
}

export function isChannelAccountsListCommand(
  value: unknown,
): value is ChannelAccountsListCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    channel_id?: unknown;
  };
  return (
    c.type === "channel_accounts_list" &&
    typeof c.request_id === "string" &&
    isChannelId(c.channel_id)
  );
}

export function isChannelAccountCreateCommand(
  value: unknown,
): value is ChannelAccountCreateCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    channel_id?: unknown;
    account?: unknown;
  };
  if (
    c.type !== "channel_account_create" ||
    typeof c.request_id !== "string" ||
    !isChannelId(c.channel_id) ||
    !c.account ||
    typeof c.account !== "object"
  ) {
    return false;
  }

  const account = c.account as Record<string, unknown>;
  if (
    (account.account_id !== undefined &&
      typeof account.account_id !== "string") ||
    !hasValidChannelPolicyFields(account) ||
    !hasOnlyFields(account, CHANNEL_ACCOUNT_CREATE_FIELDS)
  ) {
    return false;
  }

  return isValidChannelPluginConfigPayload(c.channel_id, account);
}

export function isChannelAccountUpdateCommand(
  value: unknown,
): value is ChannelAccountUpdateCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    channel_id?: unknown;
    account_id?: unknown;
    patch?: unknown;
  };
  if (
    c.type !== "channel_account_update" ||
    typeof c.request_id !== "string" ||
    !isChannelId(c.channel_id) ||
    typeof c.account_id !== "string" ||
    !c.patch ||
    typeof c.patch !== "object"
  ) {
    return false;
  }

  const patch = c.patch as Record<string, unknown>;
  if (
    !hasValidChannelPolicyFields(patch) ||
    !hasOnlyFields(patch, CHANNEL_ACCOUNT_UPDATE_FIELDS)
  ) {
    return false;
  }

  return isValidChannelPluginConfigPayload(c.channel_id, patch);
}

export function isChannelAccountBindCommand(
  value: unknown,
): value is ChannelAccountBindCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    channel_id?: unknown;
    account_id?: unknown;
    runtime?: unknown;
  };
  return (
    c.type === "channel_account_bind" &&
    typeof c.request_id === "string" &&
    isChannelId(c.channel_id) &&
    typeof c.account_id === "string" &&
    isRuntimeScope(c.runtime)
  );
}

export function isChannelAccountUnbindCommand(
  value: unknown,
): value is ChannelAccountUnbindCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    channel_id?: unknown;
    account_id?: unknown;
  };
  return (
    c.type === "channel_account_unbind" &&
    typeof c.request_id === "string" &&
    isChannelId(c.channel_id) &&
    typeof c.account_id === "string"
  );
}

export function isChannelAccountDeleteCommand(
  value: unknown,
): value is ChannelAccountDeleteCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    channel_id?: unknown;
    account_id?: unknown;
  };
  return (
    c.type === "channel_account_delete" &&
    typeof c.request_id === "string" &&
    isChannelId(c.channel_id) &&
    typeof c.account_id === "string"
  );
}

export function isChannelAccountStartCommand(
  value: unknown,
): value is ChannelAccountStartCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    channel_id?: unknown;
    account_id?: unknown;
  };
  return (
    c.type === "channel_account_start" &&
    typeof c.request_id === "string" &&
    isChannelId(c.channel_id) &&
    typeof c.account_id === "string"
  );
}

export function isChannelAccountStopCommand(
  value: unknown,
): value is ChannelAccountStopCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    channel_id?: unknown;
    account_id?: unknown;
  };
  return (
    c.type === "channel_account_stop" &&
    typeof c.request_id === "string" &&
    isChannelId(c.channel_id) &&
    typeof c.account_id === "string"
  );
}

export function isChannelGetConfigCommand(
  value: unknown,
): value is ChannelGetConfigCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    channel_id?: unknown;
    account_id?: unknown;
  };
  return (
    c.type === "channel_get_config" &&
    typeof c.request_id === "string" &&
    isChannelId(c.channel_id) &&
    (c.account_id === undefined || typeof c.account_id === "string")
  );
}

export function isChannelSetConfigCommand(
  value: unknown,
): value is ChannelSetConfigCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    channel_id?: unknown;
    account_id?: unknown;
    config?: unknown;
  };
  if (
    c.type !== "channel_set_config" ||
    typeof c.request_id !== "string" ||
    !isChannelId(c.channel_id) ||
    (c.account_id !== undefined && typeof c.account_id !== "string") ||
    !c.config ||
    typeof c.config !== "object"
  ) {
    return false;
  }
  const config = c.config as Record<string, unknown>;
  if (
    !hasValidChannelPolicyFields(config) ||
    !hasOnlyFields(config, CHANNEL_SET_CONFIG_FIELDS)
  ) {
    return false;
  }

  return isValidChannelPluginConfigPayload(
    c.channel_id,
    config,
    "plugin_config",
  );
}

export function isChannelStartCommand(
  value: unknown,
): value is ChannelStartCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    channel_id?: unknown;
    account_id?: unknown;
  };
  return (
    c.type === "channel_start" &&
    typeof c.request_id === "string" &&
    isChannelId(c.channel_id) &&
    (c.account_id === undefined || typeof c.account_id === "string")
  );
}

export function isChannelStopCommand(
  value: unknown,
): value is ChannelStopCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    channel_id?: unknown;
    account_id?: unknown;
  };
  return (
    c.type === "channel_stop" &&
    typeof c.request_id === "string" &&
    isChannelId(c.channel_id) &&
    (c.account_id === undefined || typeof c.account_id === "string")
  );
}

export function isChannelPairingsListCommand(
  value: unknown,
): value is ChannelPairingsListCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    channel_id?: unknown;
    account_id?: unknown;
  };
  return (
    c.type === "channel_pairings_list" &&
    typeof c.request_id === "string" &&
    isChannelId(c.channel_id) &&
    (c.account_id === undefined || typeof c.account_id === "string")
  );
}

export function isChannelPairingBindCommand(
  value: unknown,
): value is ChannelPairingBindCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    channel_id?: unknown;
    account_id?: unknown;
    runtime?: unknown;
    code?: unknown;
  };
  return (
    c.type === "channel_pairing_bind" &&
    typeof c.request_id === "string" &&
    isChannelId(c.channel_id) &&
    (c.account_id === undefined || typeof c.account_id === "string") &&
    isRuntimeScope(c.runtime) &&
    typeof c.code === "string" &&
    c.code.length > 0
  );
}

export function isChannelRoutesListCommand(
  value: unknown,
): value is ChannelRoutesListCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    channel_id?: unknown;
    account_id?: unknown;
    agent_id?: unknown;
    conversation_id?: unknown;
  };
  return (
    c.type === "channel_routes_list" &&
    typeof c.request_id === "string" &&
    (c.channel_id === undefined || isChannelId(c.channel_id)) &&
    (c.account_id === undefined || typeof c.account_id === "string") &&
    (c.agent_id === undefined || typeof c.agent_id === "string") &&
    (c.conversation_id === undefined || typeof c.conversation_id === "string")
  );
}

export function isChannelRouteRemoveCommand(
  value: unknown,
): value is ChannelRouteRemoveCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    channel_id?: unknown;
    account_id?: unknown;
    chat_id?: unknown;
  };
  return (
    c.type === "channel_route_remove" &&
    typeof c.request_id === "string" &&
    isChannelId(c.channel_id) &&
    (c.account_id === undefined || typeof c.account_id === "string") &&
    typeof c.chat_id === "string" &&
    c.chat_id.length > 0
  );
}

export function isChannelRouteUpdateCommand(
  value: unknown,
): value is ChannelRouteUpdateCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    channel_id?: unknown;
    account_id?: unknown;
    chat_id?: unknown;
    runtime?: unknown;
  };
  return (
    c.type === "channel_route_update" &&
    typeof c.request_id === "string" &&
    isChannelId(c.channel_id) &&
    (c.account_id === undefined || typeof c.account_id === "string") &&
    typeof c.chat_id === "string" &&
    c.chat_id.length > 0 &&
    isRuntimeScope(c.runtime)
  );
}

export function isChannelTargetsListCommand(
  value: unknown,
): value is ChannelTargetsListCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    channel_id?: unknown;
    account_id?: unknown;
  };
  return (
    c.type === "channel_targets_list" &&
    typeof c.request_id === "string" &&
    isChannelId(c.channel_id) &&
    (c.account_id === undefined || typeof c.account_id === "string")
  );
}

export function isChannelTargetBindCommand(
  value: unknown,
): value is ChannelTargetBindCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    channel_id?: unknown;
    account_id?: unknown;
    runtime?: unknown;
    target_id?: unknown;
  };
  return (
    c.type === "channel_target_bind" &&
    typeof c.request_id === "string" &&
    isChannelId(c.channel_id) &&
    (c.account_id === undefined || typeof c.account_id === "string") &&
    isRuntimeScope(c.runtime) &&
    typeof c.target_id === "string" &&
    c.target_id.length > 0
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
    args?: unknown;
  };
  const hasValidArgs = c.args === undefined || typeof c.args === "string";
  return (
    c.type === "execute_command" &&
    typeof c.command_id === "string" &&
    typeof c.request_id === "string" &&
    isRuntimeScope(c.runtime) &&
    hasValidArgs
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
      isGrepInFilesCommand(parsed) ||
      isListInDirectoryCommand(parsed) ||
      isGetTreeCommand(parsed) ||
      isReadFileCommand(parsed) ||
      isWriteFileCommand(parsed) ||
      isWatchFileCommand(parsed) ||
      isUnwatchFileCommand(parsed) ||
      isEditFileCommand(parsed) ||
      isFileOpsCommand(parsed) ||
      isListMemoryCommand(parsed) ||
      isMemoryHistoryCommand(parsed) ||
      isMemoryFileAtRefCommand(parsed) ||
      isMemoryCommitDiffCommand(parsed) ||
      isEnableMemfsCommand(parsed) ||
      isListModelsCommand(parsed) ||
      isUpdateModelCommand(parsed) ||
      isUpdateToolsetCommand(parsed) ||
      isCronListCommand(parsed) ||
      isCronAddCommand(parsed) ||
      isCronGetCommand(parsed) ||
      isCronDeleteCommand(parsed) ||
      isCronDeleteAllCommand(parsed) ||
      isSkillEnableCommand(parsed) ||
      isSkillDisableCommand(parsed) ||
      isCreateAgentCommand(parsed) ||
      isGetExperimentsCommand(parsed) ||
      isSetExperimentCommand(parsed) ||
      isGetReflectionSettingsCommand(parsed) ||
      isSetReflectionSettingsCommand(parsed) ||
      isChannelsListCommand(parsed) ||
      isChannelAccountsListCommand(parsed) ||
      isChannelAccountCreateCommand(parsed) ||
      isChannelAccountUpdateCommand(parsed) ||
      isChannelAccountBindCommand(parsed) ||
      isChannelAccountUnbindCommand(parsed) ||
      isChannelAccountDeleteCommand(parsed) ||
      isChannelAccountStartCommand(parsed) ||
      isChannelAccountStopCommand(parsed) ||
      isChannelGetConfigCommand(parsed) ||
      isChannelSetConfigCommand(parsed) ||
      isChannelStartCommand(parsed) ||
      isChannelStopCommand(parsed) ||
      isChannelPairingsListCommand(parsed) ||
      isChannelPairingBindCommand(parsed) ||
      isChannelRoutesListCommand(parsed) ||
      isChannelTargetsListCommand(parsed) ||
      isChannelTargetBindCommand(parsed) ||
      isChannelRouteUpdateCommand(parsed) ||
      isChannelRouteRemoveCommand(parsed) ||
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
