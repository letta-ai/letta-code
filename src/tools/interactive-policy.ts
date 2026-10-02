import type { ToolName } from "./tool-definitions";

/**
 * Explicit client opt-out through exclude_interactive_tools overrides an
 * additive tool include. Async questions never suspend a tool.
 */
export const INTERACTIVE_USER_INPUT_TOOL_NAMES = [
  "AskUserQuestionAsync",
] as const satisfies readonly ToolName[];
