export type ToolsetName = "codex" | "default" | "letta" | "none";

export type ToolsetPreference = ToolsetName | "auto";

export interface ToolsetOption {
  id: ToolsetPreference;
  display_name: string;
  label: string;
  description: string;
  is_featured: boolean;
}
