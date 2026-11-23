export type ToolHookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PermissionRequest";

export type SimpleHookEvent =
  | "UserPromptSubmit"
  | "Notification"
  | "Stop"
  | "SubagentStop"
  | "PreCompact"
  | "SessionStart"
  | "SessionEnd";

export type HookEvent = ToolHookEvent | SimpleHookEvent;

export interface CommandHookConfig {
  type: "command";
  command: string;
  timeout?: number;
  quiet?: boolean;
}

export interface PromptHookConfig {
  type: "prompt";
  prompt: string;
  model?: string;
  timeout?: number;
  quiet?: boolean;
}

export const PROMPT_ARGUMENTS_PLACEHOLDER = "$ARGUMENTS";

export const PROMPT_HOOK_SUPPORTED_EVENTS: Set<HookEvent> = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
]);

export function supportsPromptHooks(event: HookEvent): boolean {
  return PROMPT_HOOK_SUPPORTED_EVENTS.has(event);
}

export type HookCommand = CommandHookConfig | PromptHookConfig;

export function isCommandHook(hook: HookCommand): hook is CommandHookConfig {
  return hook.type === "command";
}

export function isPromptHook(hook: HookCommand): hook is PromptHookConfig {
  return hook.type === "prompt";
}

export interface HookMatcher {
  matcher: string;
  hooks: HookCommand[];
}

export interface SimpleHookMatcher {
  hooks: HookCommand[];
}

export type HooksConfig = {
  disabled?: boolean;
} & {
  [K in ToolHookEvent]?: HookMatcher[];
} & {
  [K in SimpleHookEvent]?: SimpleHookMatcher[];
};

export const TOOL_EVENTS: Set<HookEvent> = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
]);

export function isToolEvent(event: HookEvent): event is ToolHookEvent {
  return TOOL_EVENTS.has(event);
}

export enum HookExitCode {
  ALLOW = 0,
  ERROR = 1,
  BLOCK = 2,
}

export interface HookResult {
  exitCode: HookExitCode;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  error?: string;
}

export interface PromptHookResponse {
  ok: boolean;
  reason?: string;
}

export interface HookExecutionResult {
  blocked: boolean;
  errored: boolean;
  feedback: string[];
  results: HookResult[];
  updatedInput?: Record<string, unknown>;
}

export interface HookInputBase {
  event_type: HookEvent;
  working_directory: string;
  session_id?: string;
}

export interface PreToolUseHookInput extends HookInputBase {
  event_type: "PreToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_call_id?: string;
  agent_id?: string;
}

export interface PostToolUseHookInput extends HookInputBase {
  event_type: "PostToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_call_id?: string;
  tool_result?: {
    status: "success" | "error";
    output?: string;
  };
  agent_id?: string;
  preceding_reasoning?: string;
  preceding_assistant_message?: string;
}

export interface PostToolUseFailureHookInput extends HookInputBase {
  event_type: "PostToolUseFailure";
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_call_id?: string;
  error_message: string;
  error_type?: string;
  agent_id?: string;
  preceding_reasoning?: string;
  preceding_assistant_message?: string;
}

export interface PermissionRequestHookInput extends HookInputBase {
  event_type: "PermissionRequest";
  tool_name: string;
  tool_input: Record<string, unknown>;
  agent_id?: string;
  permission: {
    type: "allow" | "deny" | "ask";
    scope?: "session" | "project" | "user";
  };
  session_permissions?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
  };
}

export interface UserPromptSubmitHookInput extends HookInputBase {
  event_type: "UserPromptSubmit";
  prompt: string;
  is_command: boolean;
  agent_id?: string;
  conversation_id?: string;
}

export interface NotificationHookInput extends HookInputBase {
  event_type: "Notification";
  message: string;
  level?: "info" | "warning" | "error";
}

export interface StopHookInput extends HookInputBase {
  event_type: "Stop";
  stop_reason: string;
  message_count?: number;
  tool_call_count?: number;
  preceding_reasoning?: string;
  assistant_message?: string;
  user_message?: string;
}

export interface SubagentStopHookInput extends HookInputBase {
  event_type: "SubagentStop";
  subagent_type: string;
  subagent_id: string;
  success: boolean;
  error?: string;
  agent_id?: string;
  conversation_id?: string;
}

export interface PreCompactHookInput extends HookInputBase {
  event_type: "PreCompact";
  context_length?: number;
  max_context_length?: number;
  agent_id?: string;
  conversation_id?: string;
}

export interface SessionStartHookInput extends HookInputBase {
  event_type: "SessionStart";
  is_new_session: boolean;
  agent_id?: string;
  agent_name?: string;
  conversation_id?: string;
}

export interface SessionEndHookInput extends HookInputBase {
  event_type: "SessionEnd";
  duration_ms?: number;
  message_count?: number;
  tool_call_count?: number;
  agent_id?: string;
  conversation_id?: string;
}

export type HookInput =
  | PreToolUseHookInput
  | PostToolUseHookInput
  | PostToolUseFailureHookInput
  | PermissionRequestHookInput
  | UserPromptSubmitHookInput
  | NotificationHookInput
  | StopHookInput
  | SubagentStopHookInput
  | PreCompactHookInput
  | SessionStartHookInput
  | SessionEndHookInput;
