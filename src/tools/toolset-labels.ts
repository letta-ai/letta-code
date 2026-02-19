/**
 * Human-readable display names for toolset IDs.
 * Kept in a separate file to avoid pulling UI formatting logic into the heavy toolset.ts module.
 */
export const TOOLSET_DISPLAY_NAMES: Record<string, string> = {
  default: "Claude",
  codex: "Codex",
  codex_snake: "Codex (snake_case)",
  gemini: "Gemini",
  gemini_snake: "Gemini (snake_case)",
  none: "None",
  auto: "Auto",
};

/**
 * Returns the human-readable display name for a toolset ID.
 * id is optional to accommodate optional currentToolset props.
 */
export function formatToolsetName(id?: string): string {
  if (!id) return "Unknown";
  return TOOLSET_DISPLAY_NAMES[id] ?? id;
}
