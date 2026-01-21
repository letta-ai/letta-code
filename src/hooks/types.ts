// src/hooks/types.ts
// Type definitions for the hooks system

/**
 * Hook event names that can be configured
 */
export type HookEventName =
  | "PreToolUse"
  | "PermissionRequest"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "Notification"
  | "Stop"
  | "SubagentStop"
  | "PreCompact"
  | "Setup"
  | "SessionStart"
  | "SessionEnd";

/**
 * Hook events that support matchers (tool name patterns)
 */
export type MatcherHookEventName =
  | "PreToolUse"
  | "PermissionRequest"
  | "PostToolUse"
  | "Notification"
  | "PreCompact"
  | "SessionStart";

/**
 * A single hook command to execute
 */
export interface HookCommand {
  /** Hook execution type - currently only "command" supported */
  type: "command";
  /** Bash command to execute (can use $LETTA_PROJECT_DIR env var) */
  command: string;
  /** Timeout in seconds (default: 60) */
  timeout?: number;
  /** Run only once per session (skills only) */
  once?: boolean;
}

/**
 * A hook matcher that maps patterns to hook commands
 */
export interface HookMatcher {
  /**
   * Pattern to match tool names (for PreToolUse/PostToolUse/PermissionRequest)
   * - Simple strings match exactly: "Write" matches only Write tool
   * - Supports regex: "Edit|Write" or "Notebook.*"
   * - Use "*" or "" to match all tools
   *
   * For other events, matcher filters by event-specific values:
   * - Notification: notification_type (permission_prompt, idle_prompt, etc.)
   * - PreCompact: trigger (manual, auto)
   * - SessionStart: source (startup, resume, clear, compact)
   */
  matcher?: string;
  /** Array of hooks to execute when the pattern matches */
  hooks: HookCommand[];
}

/**
 * Complete hooks configuration
 */
export interface HooksConfig {
  PreToolUse?: HookMatcher[];
  PermissionRequest?: HookMatcher[];
  PostToolUse?: HookMatcher[];
  UserPromptSubmit?: HookMatcher[];
  Notification?: HookMatcher[];
  Stop?: HookMatcher[];
  SubagentStop?: HookMatcher[];
  PreCompact?: HookMatcher[];
  Setup?: HookMatcher[];
  SessionStart?: HookMatcher[];
  SessionEnd?: HookMatcher[];
}

// ============================================================================
// Hook Input Types (JSON sent to hooks via stdin)
// ============================================================================

/**
 * Common fields included in all hook inputs
 */
export interface HookInputBase {
  /** Session identifier (agent ID) */
  session_id: string;
  /** Path to conversation transcript JSON file */
  transcript_path: string;
  /** Current working directory */
  cwd: string;
  /** Current permission mode */
  permission_mode: string;
  /** Name of the hook event */
  hook_event_name: HookEventName;
}

/**
 * PreToolUse hook input
 */
export interface PreToolUseInput extends HookInputBase {
  hook_event_name: "PreToolUse";
  /** Name of the tool being called */
  tool_name: string;
  /** Tool arguments/parameters */
  tool_input: Record<string, unknown>;
  /** Unique identifier for this tool call */
  tool_use_id: string;
}

/**
 * PermissionRequest hook input
 */
export interface PermissionRequestInput extends HookInputBase {
  hook_event_name: "PermissionRequest";
  /** Name of the tool requesting permission */
  tool_name: string;
  /** Tool arguments/parameters */
  tool_input: Record<string, unknown>;
  /** Unique identifier for this tool call */
  tool_use_id: string;
}

/**
 * PostToolUse hook input
 */
export interface PostToolUseInput extends HookInputBase {
  hook_event_name: "PostToolUse";
  /** Name of the tool that was called */
  tool_name: string;
  /** Tool arguments/parameters that were used */
  tool_input: Record<string, unknown>;
  /** Response/result from the tool execution */
  tool_response: unknown;
  /** Unique identifier for this tool call */
  tool_use_id: string;
}

/**
 * UserPromptSubmit hook input
 */
export interface UserPromptSubmitInput extends HookInputBase {
  hook_event_name: "UserPromptSubmit";
  /** The user's prompt text */
  prompt: string;
}

/**
 * Notification hook input
 */
export interface NotificationInput extends HookInputBase {
  hook_event_name: "Notification";
  /** Notification message */
  message: string;
  /** Type of notification (permission_prompt, idle_prompt, etc.) */
  notification_type: string;
}

/**
 * Stop hook input
 */
export interface StopInput extends HookInputBase {
  hook_event_name: "Stop";
  /** True if agent is already continuing due to a previous stop hook */
  stop_hook_active: boolean;
}

/**
 * SubagentStop hook input
 */
export interface SubagentStopInput extends HookInputBase {
  hook_event_name: "SubagentStop";
  /** True if subagent is already continuing due to a previous stop hook */
  stop_hook_active: boolean;
}

/**
 * PreCompact hook input
 */
export interface PreCompactInput extends HookInputBase {
  hook_event_name: "PreCompact";
  /** How the compact was triggered */
  trigger: "manual" | "auto";
  /** Custom instructions from /compact command (empty for auto) */
  custom_instructions: string;
}

/**
 * Setup hook input
 */
export interface SetupInput extends HookInputBase {
  hook_event_name: "Setup";
  /** How setup was triggered */
  trigger: "init" | "maintenance";
}

/**
 * SessionStart hook input
 */
export interface SessionStartInput extends HookInputBase {
  hook_event_name: "SessionStart";
  /** How the session started */
  source: "startup" | "resume" | "clear" | "compact";
}

/**
 * SessionEnd hook input
 */
export interface SessionEndInput extends HookInputBase {
  hook_event_name: "SessionEnd";
  /** Why the session ended */
  reason: "clear" | "logout" | "prompt_input_exit" | "other";
}

/**
 * Union type of all hook inputs
 */
export type HookInput =
  | PreToolUseInput
  | PermissionRequestInput
  | PostToolUseInput
  | UserPromptSubmitInput
  | NotificationInput
  | StopInput
  | SubagentStopInput
  | PreCompactInput
  | SetupInput
  | SessionStartInput
  | SessionEndInput;

// ============================================================================
// Hook Output Types (JSON returned from hooks via stdout)
// ============================================================================

/**
 * Permission decision for PreToolUse hooks
 */
export type PermissionDecision = "allow" | "deny" | "ask";

/**
 * PreToolUse-specific output fields
 */
export interface PreToolUseHookOutput {
  hookEventName: "PreToolUse";
  /** Permission decision: allow, deny, or ask (show dialog) */
  permissionDecision?: PermissionDecision;
  /** Reason for the decision (shown to user if deny, to Claude if ask) */
  permissionDecisionReason?: string;
  /** Modified tool input to use instead of original */
  updatedInput?: Record<string, unknown>;
  /** Additional context to add for Claude */
  additionalContext?: string;
}

/**
 * PermissionRequest-specific output fields
 */
export interface PermissionRequestHookOutput {
  hookEventName: "PermissionRequest";
  decision: {
    /** Allow or deny the permission request */
    behavior: "allow" | "deny";
    /** Modified tool input (for allow) */
    updatedInput?: Record<string, unknown>;
    /** Message explaining denial (for deny) */
    message?: string;
    /** Stop Claude after denial (for deny) */
    interrupt?: boolean;
  };
}

/**
 * PostToolUse-specific output fields
 */
export interface PostToolUseHookOutput {
  hookEventName: "PostToolUse";
  /** Additional context for Claude to consider */
  additionalContext?: string;
}

/**
 * UserPromptSubmit-specific output fields
 */
export interface UserPromptSubmitHookOutput {
  hookEventName: "UserPromptSubmit";
  /** Additional context to inject before the prompt */
  additionalContext?: string;
}

/**
 * Setup-specific output fields
 */
export interface SetupHookOutput {
  hookEventName: "Setup";
  /** Additional context for the session */
  additionalContext?: string;
}

/**
 * SessionStart-specific output fields
 */
export interface SessionStartHookOutput {
  hookEventName: "SessionStart";
  /** Additional context for the session */
  additionalContext?: string;
}

/**
 * Union of hook-specific outputs
 */
export type HookSpecificOutput =
  | PreToolUseHookOutput
  | PermissionRequestHookOutput
  | PostToolUseHookOutput
  | UserPromptSubmitHookOutput
  | SetupHookOutput
  | SessionStartHookOutput;

/**
 * Complete hook output (JSON from stdout)
 */
export interface HookOutput {
  /** Whether Claude should continue after hook execution (default: true) */
  continue?: boolean;
  /** Message shown when continue is false */
  stopReason?: string;
  /** Hide stdout from transcript mode (default: false) */
  suppressOutput?: boolean;
  /** Warning message shown to user */
  systemMessage?: string;

  // Legacy fields for PostToolUse/Stop/SubagentStop (still supported)
  /** Decision for blocking hooks */
  decision?: "block";
  /** Reason for the decision */
  reason?: string;

  /** Hook-specific output fields */
  hookSpecificOutput?: HookSpecificOutput;
}

/**
 * Result of executing a single hook command
 */
export interface HookExecutionResult {
  /** The hook command that was executed */
  command: HookCommand;
  /** Exit code from the command (0 = success, 2 = blocking error) */
  exitCode: number;
  /** stdout from the command */
  stdout: string;
  /** stderr from the command */
  stderr: string;
  /** Parsed JSON output (if exit code 0 and valid JSON) */
  output?: HookOutput;
  /** Whether the hook timed out */
  timedOut: boolean;
  /** Execution duration in milliseconds */
  durationMs: number;
}

/**
 * Aggregated result from all hooks for an event
 */
export interface HookEventResult {
  /** All individual hook results */
  results: HookExecutionResult[];
  /** Whether any hook blocked the action (exit code 2 or decision: "block") */
  blocked: boolean;
  /** Blocking reason (from stderr or reason field) */
  blockReason?: string;
  /** Whether to continue processing (from continue field) */
  shouldContinue: boolean;
  /** Stop reason if shouldContinue is false */
  stopReason?: string;
  /** Aggregated additional context from all hooks */
  additionalContext?: string;
  /** Modified tool input (for PreToolUse/PermissionRequest) */
  updatedInput?: Record<string, unknown>;
  /** Permission decision (for PreToolUse) */
  permissionDecision?: PermissionDecision;
  /** Permission decision reason */
  permissionDecisionReason?: string;
  /** Permission request decision (for PermissionRequest) */
  permissionRequestDecision?: PermissionRequestHookOutput["decision"];
  /** System messages to show to user */
  systemMessages: string[];
}
