// src/hooks/types.ts
// Types for Letta Code hooks system (Claude Code-compatible)

/**
 * Tool-related hook events that require matchers to specify which tools to match
 */
export type ToolHookEvent =
  | "PreToolUse" // Runs before tool calls (can block them)
  | "PostToolUse" // Runs after tool calls complete (cannot block)
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
  | "Setup" // Runs when invoked with --init, --init-only, or --maintenance flags
  | "SessionStart" // Runs when a new session starts or is resumed
  | "SessionEnd"; // Runs when session ends (cannot block)

/**
 * All hook event types
 */
export type HookEvent = ToolHookEvent | SimpleHookEvent;

/**
 * Individual hook command configuration
 */
export interface HookCommand {
  /** Type of hook - currently only "command" is supported */
  type: "command";
  /** Shell command to execute */
  command: string;
  /** Optional timeout in milliseconds (default: 60000) */
  timeout?: number;
}

/**
 * Hook matcher configuration for tool events - matches hooks to specific tools
 */
export interface HookMatcher {
  /**
   * Tool name pattern to match:
   * - Exact name: "Bash", "Edit", "Write"
   * - Multiple tools: "Edit|Write"
   * - All tools: "*" or ""
   */
  matcher: string;
  /** List of hooks to run when matched */
  hooks: HookCommand[];
}

/**
 * Simple hook matcher for non-tool events - no matcher needed, just hooks
 */
export interface SimpleHookMatcher {
  /** List of hooks to run */
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

/**
 * Set of tool events that require matchers
 */
export const TOOL_EVENTS: Set<HookEvent> = new Set([
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
]);

/**
 * Type guard to check if an event is a tool event
 */
export function isToolEvent(event: HookEvent): event is ToolHookEvent {
  return TOOL_EVENTS.has(event);
}

/**
 * Exit codes from hook execution
 */
export enum HookExitCode {
  /** Allow/continue - hook completed successfully, proceed with action */
  ALLOW = 0,
  /** Error - hook encountered an error */
  ERROR = 1,
  /** Block/deny - hook requests to block the action */
  BLOCK = 2,
}

/**
 * Result of executing a single hook
 */
export interface HookResult {
  /** Exit code from the hook command */
  exitCode: HookExitCode;
  /** Standard output from the hook */
  stdout: string;
  /** Standard error from the hook */
  stderr: string;
  /** Whether the hook timed out */
  timedOut: boolean;
  /** Duration in milliseconds */
  durationMs: number;
  /** Error message if hook failed to execute */
  error?: string;
}

/**
 * Aggregated result from running all matched hooks
 */
export interface HookExecutionResult {
  /** Whether any hook blocked the action */
  blocked: boolean;
  /** Whether any hook errored */
  errored: boolean;
  /** Feedback messages from hooks (stdout when blocking) */
  feedback: string[];
  /** Individual results from each hook */
  results: HookResult[];
}

// ============================================================================
// Input payloads for different hook events
// ============================================================================

/**
 * Base input structure sent to all hooks
 */
export interface HookInputBase {
  /** The event type that triggered this hook */
  event_type: HookEvent;
  /** Working directory */
  working_directory: string;
  /** Session ID if available */
  session_id?: string;
}

/**
 * Input for PreToolUse hooks
 */
export interface PreToolUseHookInput extends HookInputBase {
  event_type: "PreToolUse";
  /** Name of the tool being used */
  tool_name: string;
  /** Tool input arguments */
  tool_input: Record<string, unknown>;
  /** Tool call ID */
  tool_call_id?: string;
  /** Agent ID (for server-side tools like memory) */
  agent_id?: string;
}

/**
 * Input for PostToolUse hooks
 */
export interface PostToolUseHookInput extends HookInputBase {
  event_type: "PostToolUse";
  /** Name of the tool that was used */
  tool_name: string;
  /** Tool input arguments */
  tool_input: Record<string, unknown>;
  /** Tool call ID */
  tool_call_id?: string;
  /** Tool execution result */
  tool_result?: {
    status: "success" | "error";
    output?: string;
  };
  /** Agent ID (for server-side tools like memory) */
  agent_id?: string;
}

/**
 * Input for PermissionRequest hooks
 */
export interface PermissionRequestHookInput extends HookInputBase {
  event_type: "PermissionRequest";
  /** Name of the tool requesting permission */
  tool_name: string;
  /** Tool input arguments */
  tool_input: Record<string, unknown>;
  /** Permission being requested */
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

/**
 * Input for UserPromptSubmit hooks
 */
export interface UserPromptSubmitHookInput extends HookInputBase {
  event_type: "UserPromptSubmit";
  /** The user's prompt text */
  prompt: string;
  /** Whether this is a command (starts with /) */
  is_command: boolean;
  /** Agent ID if available */
  agent_id?: string;
  /** Conversation ID if available */
  conversation_id?: string;
}

/**
 * Input for Notification hooks
 */
export interface NotificationHookInput extends HookInputBase {
  event_type: "Notification";
  /** Notification message */
  message: string;
  /** Notification type/level */
  level?: "info" | "warning" | "error";
}

/**
 * Input for Stop hooks
 */
export interface StopHookInput extends HookInputBase {
  event_type: "Stop";
  /** Stop reason from the API */
  stop_reason: string;
  /** Number of messages in the turn */
  message_count?: number;
  /** Number of tool calls in the turn */
  tool_call_count?: number;
}

/**
 * Input for SubagentStop hooks
 */
export interface SubagentStopHookInput extends HookInputBase {
  event_type: "SubagentStop";
  /** Subagent type */
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

/**
 * Input for PreCompact hooks
 */
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

/**
 * Input for Setup hooks
 */
export interface SetupHookInput extends HookInputBase {
  event_type: "Setup";
  /** Which init flag was used */
  init_type: "init" | "init-only" | "maintenance";
}

/**
 * Input for SessionStart hooks
 */
export interface SessionStartHookInput extends HookInputBase {
  event_type: "SessionStart";
  /** Whether this is a new session or resumed */
  is_new_session: boolean;
  /** Agent ID */
  agent_id?: string;
  /** Agent name */
  agent_name?: string;
  /** Conversation ID */
  conversation_id?: string;
}

/**
 * Input for SessionEnd hooks
 */
export interface SessionEndHookInput extends HookInputBase {
  event_type: "SessionEnd";
  /** Session duration in milliseconds */
  duration_ms?: number;
  /** Total messages in session */
  message_count?: number;
  /** Total tool calls in session */
  tool_call_count?: number;
  /** Agent ID */
  agent_id?: string;
  /** Conversation ID */
  conversation_id?: string;
}

/**
 * Union type for all hook inputs
 */
export type HookInput =
  | PreToolUseHookInput
  | PostToolUseHookInput
  | PermissionRequestHookInput
  | UserPromptSubmitHookInput
  | NotificationHookInput
  | StopHookInput
  | SubagentStopHookInput
  | PreCompactHookInput
  | SetupHookInput
  | SessionStartHookInput
  | SessionEndHookInput;
