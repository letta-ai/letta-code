import { TOOLSET_OPTIONS } from "./toolset-catalog";

export const TOOLSET_DISPLAY_NAMES: Record<string, string> = Object.fromEntries(
  TOOLSET_OPTIONS.map((option) => [option.id, option.display_name]),
);

export function formatToolsetName(id?: string): string {
  if (!id) return "Unknown";
  return TOOLSET_DISPLAY_NAMES[id] ?? id;
}
