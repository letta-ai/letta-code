import { loadSpecificTools, loadTools } from "./manager";
import type { ToolName } from "./tool-definitions";

export type StartupToolsetPreference =
  | "auto"
  | "codex"
  | "default"
  | "gemini"
  | "letta";

/** Letta's model-independent toolset with one preferred tool for each job. */
export const LETTA_TOOLS: ToolName[] = [
  "AskUserQuestion",
  "EnterWorktree",
  "ExitWorktree",
  "SetWorkingDirectory",
  "memory",
  "Task",
  "Monitor",
  "TaskOutput",
  "TaskStop",
  "Skill",
  "exec_command",
  "write_stdin",
  "Read",
  "Edit",
  "Write",
  "ViewImage",
  "UpdatePlan",
];

export async function loadStartupTools(params: {
  modelIdentifier?: string;
  toolset?: StartupToolsetPreference;
  exclude?: ToolName[];
}): Promise<void> {
  const { modelIdentifier, toolset, exclude = [] } = params;
  if (toolset === "letta") {
    await loadSpecificTools(
      LETTA_TOOLS.filter((toolName) => !exclude.includes(toolName)),
    );
    return;
  }

  const modelForTools =
    toolset === "codex"
      ? "openai/gpt-4"
      : toolset === "gemini"
        ? "google_ai/gemini-3.1-pro-preview"
        : toolset === "default"
          ? "anthropic/claude-sonnet-4"
          : modelIdentifier;
  await loadTools(modelForTools, { exclude });
}
