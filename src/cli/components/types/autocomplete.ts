/**
 * Shared types for autocomplete components
 */

/**
 * Base props shared by all autocomplete components
 */
export interface AutocompleteProps {
  /** Current input text from the user */
  currentInput: string;
  /** Current cursor position in the input */
  cursorPosition?: number;
  /** Callback when an item is selected (Enter key - may execute) */
  onSelect?: (value: string) => void;
  /** Callback when an item is autocompleted (Tab key - fill text only) */
  onAutocomplete?: (value: string) => void;
  /** Callback when autocomplete active state changes */
  onActiveChange?: (isActive: boolean) => void;
  /** Current agent ID for context-sensitive command filtering */
  agentId?: string;
  /** Working directory for local pin status checking */
  workingDirectory?: string;
}

/**
 * File autocomplete match item
 */
export interface FileMatch {
  path: string;
  type: "file" | "dir" | "url";
}

/**
 * Slash command autocomplete match item
 */
export interface CommandMatch {
  cmd: string;
  desc: string;
  order?: number;
}
