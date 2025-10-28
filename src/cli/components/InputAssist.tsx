import { CommandPreview } from "./CommandPreview";
import { FileAutocomplete } from "./FileAutocomplete";

interface InputAssistProps {
  currentInput: string;
  cursorPosition: number;
  onFileSelect: (path: string) => void;
  onAutocompleteActiveChange: (isActive: boolean) => void;
}

/**
 * Shows contextual assistance below the input:
 * - File autocomplete when "@" is detected
 * - Command preview when "/" is detected
 * - Nothing otherwise
 */
export function InputAssist({
  currentInput,
  cursorPosition,
  onFileSelect,
  onAutocompleteActiveChange,
}: InputAssistProps) {
  // Show file autocomplete when @ is present
  if (currentInput.includes("@")) {
    return (
      <FileAutocomplete
        currentInput={currentInput}
        cursorPosition={cursorPosition}
        onSelect={onFileSelect}
        onActiveChange={onAutocompleteActiveChange}
      />
    );
  }

  // Show command preview when input starts with /
  if (currentInput.startsWith("/")) {
    return <CommandPreview currentInput={currentInput} />;
  }

  // No assistance needed
  return null;
}
