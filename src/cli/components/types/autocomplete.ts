export interface ModCommandAutocompleteItem {
  id: string;
  description: string;
  args?: string;
  order: number;
}

export interface SessionCompletions {
  commands: CommandMatch[];
  searchFiles: (query: string) => Promise<string[]>;
}

export interface AutocompleteProps {
  session?: SessionCompletions;
  currentInput: string;
  cursorPosition?: number;
  onSelect?: (value: string) => void;
  onAutocomplete?: (value: string) => void;
  onActiveChange?: (isActive: boolean) => void;
  agentId?: string;
  workingDirectory?: string;
  modCommands?: Record<string, ModCommandAutocompleteItem>;
}

export interface CommandMatch {
  cmd: string;
  desc: string;
  order?: number;
}
