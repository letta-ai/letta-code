// src/hooks/input.ts
// Build JSON input for hooks

import { homedir } from "node:os";
import { join } from "node:path";
import { permissionMode } from "../permissions/mode";
import type {
  HookEventName,
  HookInput,
  HookInputBase,
  NotificationInput,
  PermissionRequestInput,
  PostToolUseInput,
  PreCompactInput,
  PreToolUseInput,
  SessionEndInput,
  SessionStartInput,
  SetupInput,
  StopInput,
  SubagentStopInput,
  UserPromptSubmitInput,
} from "./types";

/**
 * Get the transcript path for the current session.
 * Uses the same path structure as Claude Code for compatibility.
 */
function getTranscriptPath(sessionId: string): string {
  // Store transcripts in ~/.letta/projects/{cwd_hash}/{session_id}.jsonl
  const cwd = process.cwd();
  const cwdHash = Buffer.from(cwd).toString("base64url").slice(0, 32);
  return join(homedir(), ".letta", "projects", cwdHash, `${sessionId}.jsonl`);
}

/**
 * Build common base fields for all hook inputs
 */
function buildBaseInput(
  eventName: HookEventName,
  sessionId: string,
): HookInputBase {
  return {
    session_id: sessionId,
    transcript_path: getTranscriptPath(sessionId),
    cwd: process.cwd(),
    permission_mode: permissionMode.getMode(),
    hook_event_name: eventName,
  };
}

/**
 * Build PreToolUse hook input
 */
export function buildPreToolUseInput(
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseId: string,
): PreToolUseInput {
  return {
    ...buildBaseInput("PreToolUse", sessionId),
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
  };
}

/**
 * Build PermissionRequest hook input
 */
export function buildPermissionRequestInput(
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseId: string,
): PermissionRequestInput {
  return {
    ...buildBaseInput("PermissionRequest", sessionId),
    hook_event_name: "PermissionRequest",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
  };
}

/**
 * Build PostToolUse hook input
 */
export function buildPostToolUseInput(
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResponse: unknown,
  toolUseId: string,
): PostToolUseInput {
  return {
    ...buildBaseInput("PostToolUse", sessionId),
    hook_event_name: "PostToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: toolResponse,
    tool_use_id: toolUseId,
  };
}

/**
 * Build UserPromptSubmit hook input
 */
export function buildUserPromptSubmitInput(
  sessionId: string,
  prompt: string,
): UserPromptSubmitInput {
  return {
    ...buildBaseInput("UserPromptSubmit", sessionId),
    hook_event_name: "UserPromptSubmit",
    prompt,
  };
}

/**
 * Build Notification hook input
 */
export function buildNotificationInput(
  sessionId: string,
  message: string,
  notificationType: string,
): NotificationInput {
  return {
    ...buildBaseInput("Notification", sessionId),
    hook_event_name: "Notification",
    message,
    notification_type: notificationType,
  };
}

/**
 * Build Stop hook input
 */
export function buildStopInput(
  sessionId: string,
  stopHookActive: boolean,
): StopInput {
  return {
    ...buildBaseInput("Stop", sessionId),
    hook_event_name: "Stop",
    stop_hook_active: stopHookActive,
  };
}

/**
 * Build SubagentStop hook input
 */
export function buildSubagentStopInput(
  sessionId: string,
  stopHookActive: boolean,
): SubagentStopInput {
  return {
    ...buildBaseInput("SubagentStop", sessionId),
    hook_event_name: "SubagentStop",
    stop_hook_active: stopHookActive,
  };
}

/**
 * Build PreCompact hook input
 */
export function buildPreCompactInput(
  sessionId: string,
  trigger: "manual" | "auto",
  customInstructions: string,
): PreCompactInput {
  return {
    ...buildBaseInput("PreCompact", sessionId),
    hook_event_name: "PreCompact",
    trigger,
    custom_instructions: customInstructions,
  };
}

/**
 * Build Setup hook input
 */
export function buildSetupInput(
  sessionId: string,
  trigger: "init" | "maintenance",
): SetupInput {
  return {
    ...buildBaseInput("Setup", sessionId),
    hook_event_name: "Setup",
    trigger,
  };
}

/**
 * Build SessionStart hook input
 */
export function buildSessionStartInput(
  sessionId: string,
  source: "startup" | "resume" | "clear" | "compact",
): SessionStartInput {
  return {
    ...buildBaseInput("SessionStart", sessionId),
    hook_event_name: "SessionStart",
    source,
  };
}

/**
 * Build SessionEnd hook input
 */
export function buildSessionEndInput(
  sessionId: string,
  reason: "clear" | "logout" | "prompt_input_exit" | "other",
): SessionEndInput {
  return {
    ...buildBaseInput("SessionEnd", sessionId),
    hook_event_name: "SessionEnd",
    reason,
  };
}

/**
 * Serialize hook input to JSON string for passing via stdin
 */
export function serializeHookInput(input: HookInput): string {
  return JSON.stringify(input);
}
