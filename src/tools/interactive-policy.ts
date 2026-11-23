import type { ToolName } from "./tool-definitions";

export const INTERACTIVE_USER_INPUT_TOOL_NAMES = [
  "AskUserQuestionAsync",
] as const satisfies readonly ToolName[];
