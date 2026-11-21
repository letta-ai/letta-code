// src/hooks/types.ts
// Types for Letta Code hooks system (Claude Code-compatible)

/**
 * Tool-related hook events that require matchers to specify which tools to match
 */
export type ToolHookEvent =
  | "PreToolUse" // Runs before tool calls (can block them)
  | "PostToolUse" // Runs after tool calls complete (cannot block)
  | "PostToolUseFailure" // Runs after tool calls fail (cannot block, feeds stderr back to agent)
  | "PermissionRequest"; // Runs when a permission dialog is shown (can allow or deny)

/**
 * Simple hook events that don't require matchers
 */
export type SimpleHookEvent =
  | "UserPromptSubmit" // Runs when the user submits a prompt (can block)
  | "Notification" // Runs when a notification is sent (cannot block)
  | "Stop" // Runs when the agent finishes responding (can block)
  | "SubagentStop" // Runs when subagent tasks complete (can block)
  | "PreCompact" // Runs before a compact operation (cannot block)
  | "SessionStart" // Runs when a new session starts or is resumed
  | "SessionEnd"; // Runs when session ends (cannot block)

export type HookEvent = ToolHookEvent | SimpleHookEvent;

export interface CommandHookConfig {
  type: "command";
  command: string;
  /** Optional timeout in milliseconds (default: 60000 for command hooks) */
  timeout?: number;
  /** When true, suppress hook output in the TUI */
  quiet?: boolean;
}

/**
 * Prompt hook configuration - sends hook input to an LLM for evaluation.
 * Supported events: PreToolUse, PostToolUse, PostToolUseFailure,
 * PermissionRequest, UserPromptSubmit, Stop, and SubagentStop.
 */
export interface PromptHookConfig {
  type: "prompt";
  /**
   * Prompt text to send to the model.
   * Use $ARGUMENTS as a placeholder for the hook input JSON.
   */
  prompt: string;
  model?: string;
  /** Optional timeout in milliseconds (default: 30000 for prompt hooks) */
  timeout?: number;
  /** When true, suppress hook output in the TUI */
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
  /**
   * Tool name pattern to match:
   * - Exact name: "Bash", "Edit", "Write"
   * - Multiple tools: "Edit|Write"
   * - All tools: "*" or ""
   */
  matcher: string;
  hooks: HookCommand[];
}

export interface SimpleHookMatcher {
  hooks: HookCommand[];
}

/**
 * Full hooks configuration stored in settings
 * - Tool events (PreToolUse, PostToolUse, PermissionRequest) use HookMatcher[] with matcher patterns
 * - Simple events use SimpleHookMatcher[] (same structure, just no matcher field)
 * - disabled: when true, prevents all hooks from firing (checked across all config levels)
 */
export type HooksConfig = {
  /** When true, disables all hooks. User false overrides project settings; otherwise any true disables. */
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
  /** Allow/continue - hook completed successfully, proceed with action */
  ALLOW = 0,
  /** Error - hook encountered an error */
  ERROR = 1,
  /** Block/deny - hook requests to block the action */
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

/**
 * Expected JSON response structure from prompt hooks.
 * The LLM must respond with this schema per Claude Code spec.
 */
export interface PromptHookResponse {
  /** true allows the action, false prevents it */
  ok: boolean;
  /** Required when ok is false. Explanation shown to Claude. */
  reason?: string;
}

export interface HookExecutionResult {
  blocked: boolean;
  errored: boolean;
  /** Feedback messages from hooks (stdout when blocking) */
  feedback: string[];
  results: HookResult[];
  /** Rewritten tool input from a hook (PreToolUse updatedInput protocol) */
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

/**
 * Input for PostToolUseFailure hooks
 * Triggered after a tool call fails. Non-blocking, but stderr is fed back to the agent.
 */
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
  /** Current session permissions (in-memory only, cleared on exit) */
  session_permissions?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
  };
}

export interface UserPromptSubmitHookInput extends HookInputBase {
  event_type: "UserPromptSubmit";
  prompt: string;
  /** Whether this is a command (starts with /) */
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
  /** Subagent ID */
  subagent_id: string;
  /** Whether subagent succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Subagent's agent ID */
  agent_id?: string;
  /** Subagent's conversation ID */
  conversation_id?: string;
}

export interface PreCompactHookInput extends HookInputBase {
  event_type: "PreCompact";
  /** Current context length */
  context_length?: number;
  /** Maximum context length */
  max_context_length?: number;
  /** Agent ID */
  agent_id?: string;
  /** Conversation ID */
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
