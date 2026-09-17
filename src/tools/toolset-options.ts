import type { ToolsetOption, ToolsetPreference } from "./toolset-types";

/** Toolsets this Letta Code runtime can load and present to clients. */
export const TOOLSET_OPTIONS: readonly ToolsetOption[] = [
  {
    id: "auto",
    display_name: "Auto",
    label: "Auto",
    description: "Auto-select based on the model",
    is_featured: true,
  },
  {
    id: "letta",
    display_name: "Letta",
    label: "Letta toolset",
    description: "Experimental unified toolset for every model",
    is_featured: true,
  },
  {
    id: "none",
    display_name: "None",
    label: "None",
    description: "Remove all Letta Code tools from your agent",
    is_featured: true,
  },
  {
    id: "default",
    display_name: "Claude",
    label: "Claude toolset",
    description: "Optimized for Anthropic models",
    is_featured: true,
  },
  {
    id: "codex",
    display_name: "Codex",
    label: "Codex toolset",
    description: "Optimized for GPT/Codex models",
    is_featured: true,
  },
];

export function isToolsetPreference(
  value: unknown,
): value is ToolsetPreference {
  return TOOLSET_OPTIONS.some((option) => option.id === value);
}
