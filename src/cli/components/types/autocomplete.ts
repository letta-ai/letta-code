
export interface ModCommandAutocompleteItem {
  id: string;
  description: string;
  args?: string;
  order: number;
}

export interface AutocompleteProps {
  currentInput: string;
  cursorPosition?: number;
  /** Callback when an item is selected (Enter key - may execute) */
  onSelect?: (value: string) => void;
  /** Callback when an item is autocompleted (Tab key - fill text only) */
  onAutocomplete?: (value: string) => void;
  onActiveChange?: (isActive: boolean) => void;
  /** Current agent ID for context-sensitive command filtering */
  agentId?: string;
  /** Working directory for local pin status checking */
  workingDirectory?: string;
  /** Slash commands registered by trusted local mods */
  modCommands?: Record<string, ModCommandAutocompleteItem>;
}

/**
 * Slash command autocomplete match item
 */
export interface CommandMatch {
  cmd: string;
  desc: string;
  order?: number;
}
