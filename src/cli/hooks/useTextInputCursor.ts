import { useState } from "react";

interface Key {
  leftArrow?: boolean;
  rightArrow?: boolean;
  backspace?: boolean;
  delete?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

/**
 * Custom hook for managing text input with cursor position tracking.
 *
 * Handles:
 * - Left/right arrow key navigation within text
 * - Backspace at cursor position (not just end)
 * - Character insertion at cursor position
 *
 * @returns Object with text state, cursor position, key handler, and clear function
 */
export function useTextInputCursor(initialText = "") {
  const [text, setText] = useState(initialText);
  const [cursorPos, setCursorPos] = useState(0);

  /**
   * Handle keyboard input for text editing.
   * @returns true if the key was handled, false otherwise
   */
  const handleKey = (input: string, key: Key): boolean => {
    // Arrow key navigation
    if (key.leftArrow) {
      setCursorPos((prev) => Math.max(0, prev - 1));
      return true;
    }
    if (key.rightArrow) {
      setCursorPos((prev) => Math.min(text.length, prev + 1));
      return true;
    }

    // Backspace: delete character before cursor
    if (key.backspace || key.delete) {
      if (cursorPos > 0) {
        setText((prev) => prev.slice(0, cursorPos - 1) + prev.slice(cursorPos));
        setCursorPos((prev) => prev - 1);
      }
      return true;
    }

    // Typing: insert at cursor position
    if (input && !key.ctrl && !key.meta && input.length === 1) {
      setText(
        (prev) => prev.slice(0, cursorPos) + input + prev.slice(cursorPos),
      );
      setCursorPos((prev) => prev + 1);
      return true;
    }

    return false;
  };

  /**
   * Clear text and reset cursor to start
   */
  const clear = () => {
    setText("");
    setCursorPos(0);
  };

  return {
    text,
    setText,
    cursorPos,
    setCursorPos,
    handleKey,
    clear,
  };
}
