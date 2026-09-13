export type ToolsetName =
  | "codex"
  | "codex_snake"
  | "default"
  | "gemini"
  | "gemini_snake"
  | "letta"
  | "none";

export type ToolsetPreference = ToolsetName | "auto";

export interface ToolsetOption {
  id: ToolsetPreference;
  display_name: string;
  label: string;
  description: string;
  is_featured: boolean;
}
