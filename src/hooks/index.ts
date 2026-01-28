// src/hooks/index.ts
// Main hooks module - provides high-level API for running hooks

import { sessionPermissions } from "../permissions/session";
import { executeHooks, executeHooksParallel } from "./executor";
import { getHooksForEvent, hasHooksForEvent, loadHooks } from "./loader";
import type {
  HookEvent,
  HookExecutionResult,
  NotificationHookInput,
  PermissionRequestHookInput,
  PostToolUseHookInput,
  PreCompactHookInput,
  PreToolUseHookInput,
  SessionEndHookInput,
  SessionStartHookInput,
  SetupHookInput,
  StopHookInput,
  SubagentStopHookInput,
  UserPromptSubmitHookInput,
} from "./types";

export { areHooksDisabled, clearHooksCache } from "./loader";
// Re-export types for convenience
export * from "./types";

// ============================================================================
// High-level hook runner functions
// ============================================================================

/**
 * Run PreToolUse hooks before a tool is executed
 * Can block the tool call by returning blocked: true
 */
export async function runPreToolUseHooks(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolCallId?: string,
  workingDirectory: string = process.cwd(),
  agentId?: string,
): Promise<HookExecutionResult> {
  const hooks = await getHooksForEvent(
    "PreToolUse",
    toolName,
    workingDirectory,
  );
  if (hooks.length === 0) {
    return { blocked: false, errored: false, feedback: [], results: [] };
  }

  const input: PreToolUseHookInput = {
    event_type: "PreToolUse",
    working_directory: workingDirectory,
    tool_name: toolName,
    tool_input: toolInput,
    tool_call_id: toolCallId,
    agent_id: agentId,
  };

  // Run sequentially - stop on first block
  return executeHooks(hooks, input, workingDirectory);
}

/**
 * Run PostToolUse hooks after a tool has executed
 * These run in parallel since they cannot block
 */
export async function runPostToolUseHooks(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResult: { status: "success" | "error"; output?: string },
  toolCallId?: string,
  workingDirectory: string = process.cwd(),
  agentId?: string,
): Promise<HookExecutionResult> {
  const hooks = await getHooksForEvent(
    "PostToolUse",
    toolName,
    workingDirectory,
  );
  if (hooks.length === 0) {
    return { blocked: false, errored: false, feedback: [], results: [] };
  }

  const input: PostToolUseHookInput = {
    event_type: "PostToolUse",
    working_directory: workingDirectory,
    tool_name: toolName,
    tool_input: toolInput,
    tool_call_id: toolCallId,
    tool_result: toolResult,
    agent_id: agentId,
  };

  // Run in parallel since PostToolUse cannot block
  return executeHooksParallel(hooks, input, workingDirectory);
}

/**
 * Run PermissionRequest hooks when a permission dialog would be shown
 * Can auto-allow (exit 0) or auto-deny (exit 2) the permission
 */
export async function runPermissionRequestHooks(
  toolName: string,
  toolInput: Record<string, unknown>,
  permissionType: "allow" | "deny" | "ask",
  scope?: "session" | "project" | "user",
  workingDirectory: string = process.cwd(),
): Promise<HookExecutionResult> {
  const hooks = await getHooksForEvent(
    "PermissionRequest",
    toolName,
    workingDirectory,
  );
  if (hooks.length === 0) {
    return { blocked: false, errored: false, feedback: [], results: [] };
  }

  const input: PermissionRequestHookInput = {
    event_type: "PermissionRequest",
    working_directory: workingDirectory,
    tool_name: toolName,
    tool_input: toolInput,
    permission: {
      type: permissionType,
      scope,
    },
    session_permissions: sessionPermissions.getRules(),
  };

  // Run sequentially - first hook that returns 0 or 2 determines outcome
  return executeHooks(hooks, input, workingDirectory);
}

/**
 * Run UserPromptSubmit hooks before processing a user's prompt
 * Can block the prompt from being processed
 */
export async function runUserPromptSubmitHooks(
  prompt: string,
  isCommand: boolean,
  agentId?: string,
  conversationId?: string,
  workingDirectory: string = process.cwd(),
): Promise<HookExecutionResult> {
  const hooks = await getHooksForEvent(
    "UserPromptSubmit",
    undefined,
    workingDirectory,
  );
  if (hooks.length === 0) {
    return { blocked: false, errored: false, feedback: [], results: [] };
  }

  const input: UserPromptSubmitHookInput = {
    event_type: "UserPromptSubmit",
    working_directory: workingDirectory,
    prompt,
    is_command: isCommand,
    agent_id: agentId,
    conversation_id: conversationId,
  };

  return executeHooks(hooks, input, workingDirectory);
}

/**
 * Run Notification hooks when a notification is sent
 * These run in parallel and cannot block
 */
export async function runNotificationHooks(
  message: string,
  level: "info" | "warning" | "error" = "info",
  workingDirectory: string = process.cwd(),
): Promise<HookExecutionResult> {
  const hooks = await getHooksForEvent(
    "Notification",
    undefined,
    workingDirectory,
  );
  if (hooks.length === 0) {
    return { blocked: false, errored: false, feedback: [], results: [] };
  }

  const input: NotificationHookInput = {
    event_type: "Notification",
    working_directory: workingDirectory,
    message,
    level,
  };

  // Run in parallel - notifications cannot block
  return executeHooksParallel(hooks, input, workingDirectory);
}

/**
 * Run Stop hooks when the agent finishes responding
 * Can block stoppage (exit 2), stderr shown to model
 */
export async function runStopHooks(
  stopReason: string,
  messageCount?: number,
  toolCallCount?: number,
  workingDirectory: string = process.cwd(),
): Promise<HookExecutionResult> {
  const hooks = await getHooksForEvent("Stop", undefined, workingDirectory);
  if (hooks.length === 0) {
    return { blocked: false, errored: false, feedback: [], results: [] };
  }

  const input: StopHookInput = {
    event_type: "Stop",
    working_directory: workingDirectory,
    stop_reason: stopReason,
    message_count: messageCount,
    tool_call_count: toolCallCount,
  };

  // Run sequentially - Stop can block
  return executeHooks(hooks, input, workingDirectory);
}

/**
 * Run SubagentStop hooks when a subagent task completes
 * Can block stoppage (exit 2), stderr shown to subagent
 */
export async function runSubagentStopHooks(
  subagentType: string,
  subagentId: string,
  success: boolean,
  error?: string,
  agentId?: string,
  conversationId?: string,
  workingDirectory: string = process.cwd(),
): Promise<HookExecutionResult> {
  const hooks = await getHooksForEvent(
    "SubagentStop",
    undefined,
    workingDirectory,
  );
  if (hooks.length === 0) {
    return { blocked: false, errored: false, feedback: [], results: [] };
  }

  const input: SubagentStopHookInput = {
    event_type: "SubagentStop",
    working_directory: workingDirectory,
    subagent_type: subagentType,
    subagent_id: subagentId,
    success,
    error,
    agent_id: agentId,
    conversation_id: conversationId,
  };

  // Run sequentially - SubagentStop can block
  return executeHooks(hooks, input, workingDirectory);
}

/**
 * Run PreCompact hooks before a compact operation
 * Cannot block, stderr shown to user only
 */
export async function runPreCompactHooks(
  contextLength?: number,
  maxContextLength?: number,
  agentId?: string,
  conversationId?: string,
  workingDirectory: string = process.cwd(),
): Promise<HookExecutionResult> {
  const hooks = await getHooksForEvent(
    "PreCompact",
    undefined,
    workingDirectory,
  );
  if (hooks.length === 0) {
    return { blocked: false, errored: false, feedback: [], results: [] };
  }

  const input: PreCompactHookInput = {
    event_type: "PreCompact",
    working_directory: workingDirectory,
    context_length: contextLength,
    max_context_length: maxContextLength,
    agent_id: agentId,
    conversation_id: conversationId,
  };

  // Run in parallel - PreCompact cannot block
  return executeHooksParallel(hooks, input, workingDirectory);
}

/**
 * Run Setup hooks when CLI is invoked with init flags
 */
export async function runSetupHooks(
  initType: "init" | "init-only" | "maintenance",
  workingDirectory: string = process.cwd(),
): Promise<HookExecutionResult> {
  const hooks = await getHooksForEvent("Setup", undefined, workingDirectory);
  if (hooks.length === 0) {
    return { blocked: false, errored: false, feedback: [], results: [] };
  }

  const input: SetupHookInput = {
    event_type: "Setup",
    working_directory: workingDirectory,
    init_type: initType,
  };

  return executeHooks(hooks, input, workingDirectory);
}

/**
 * Run SessionStart hooks when a session begins
 */
export async function runSessionStartHooks(
  isNewSession: boolean,
  agentId?: string,
  agentName?: string,
  conversationId?: string,
  workingDirectory: string = process.cwd(),
): Promise<HookExecutionResult> {
  const hooks = await getHooksForEvent(
    "SessionStart",
    undefined,
    workingDirectory,
  );
  if (hooks.length === 0) {
    return { blocked: false, errored: false, feedback: [], results: [] };
  }

  const input: SessionStartHookInput = {
    event_type: "SessionStart",
    working_directory: workingDirectory,
    is_new_session: isNewSession,
    agent_id: agentId,
    agent_name: agentName,
    conversation_id: conversationId,
  };

  return executeHooks(hooks, input, workingDirectory);
}

/**
 * Run SessionEnd hooks when a session ends
 */
export async function runSessionEndHooks(
  durationMs?: number,
  messageCount?: number,
  toolCallCount?: number,
  agentId?: string,
  conversationId?: string,
  workingDirectory: string = process.cwd(),
): Promise<HookExecutionResult> {
  const hooks = await getHooksForEvent(
    "SessionEnd",
    undefined,
    workingDirectory,
  );
  if (hooks.length === 0) {
    return { blocked: false, errored: false, feedback: [], results: [] };
  }

  const input: SessionEndHookInput = {
    event_type: "SessionEnd",
    working_directory: workingDirectory,
    duration_ms: durationMs,
    message_count: messageCount,
    tool_call_count: toolCallCount,
    agent_id: agentId,
    conversation_id: conversationId,
  };

  // Run in parallel - SessionEnd cannot block (session is already ending)
  return executeHooksParallel(hooks, input, workingDirectory);
}

/**
 * Check if hooks are configured for a specific event
 */
export async function hasHooks(
  event: HookEvent,
  workingDirectory: string = process.cwd(),
): Promise<boolean> {
  const config = await loadHooks(workingDirectory);
  return hasHooksForEvent(config, event);
}
