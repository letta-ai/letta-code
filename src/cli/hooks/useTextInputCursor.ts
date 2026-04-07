import { useState } from "react";

export interface TextInputKey {
  leftArrow?: boolean;
  rightArrow?: boolean;
  home?: boolean;
  end?: boolean;
  backspace?: boolean;
  delete?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  isPasted?: boolean;
}

type TextInputState = {
  text: string;
  cursorPos: number;
};

type TextInputResult = TextInputState & { handled: boolean };

function findPreviousWordStart(text: string, cursorPos: number): number {
  let pos = cursorPos;
  while (pos > 0 && text[pos - 1] === " ") {
    pos -= 1;
  }
  while (pos > 0 && text[pos - 1] !== " ") {
    pos -= 1;
  }
  return pos;
}

export function applyTextInputKey(
  state: TextInputState,
  input: string,
  key: TextInputKey,
): TextInputResult {
  const { text, cursorPos } = state;

  // Arrow key navigation
  if (key.leftArrow || (key.ctrl && input === "b")) {
    return {
      text,
      cursorPos: Math.max(0, cursorPos - 1),
      handled: true,
    };
  }
  if (key.rightArrow || (key.ctrl && input === "f")) {
    return {
      text,
      cursorPos: Math.min(text.length, cursorPos + 1),
      handled: true,
    };
  }

  // Line navigation
  if (key.home || (key.ctrl && input === "a")) {
    return { text, cursorPos: 0, handled: true };
  }
  if (key.end || (key.ctrl && input === "e")) {
    return { text, cursorPos: text.length, handled: true };
  }

  // Kill shortcuts
  if (key.ctrl && input === "u") {
    return {
      text: text.slice(cursorPos),
      cursorPos: 0,
      handled: true,
    };
  }
  if (key.ctrl && input === "k") {
    return {
      text: text.slice(0, cursorPos),
      cursorPos,
      handled: true,
    };
  }
  if (key.ctrl && input === "w") {
    if (cursorPos === 0) {
      return { text, cursorPos, handled: true };
    }
    const start = findPreviousWordStart(text, cursorPos);
    return {
      text: text.slice(0, start) + text.slice(cursorPos),
      cursorPos: start,
      handled: true,
    };
  }

  // Backspace/delete: delete character before cursor (same behavior in this single-line editor)
  if (key.backspace || key.delete) {
    if (cursorPos > 0) {
      return {
        text: text.slice(0, cursorPos - 1) + text.slice(cursorPos),
        cursorPos: cursorPos - 1,
        handled: true,
      };
    }
    return { text, cursorPos, handled: true };
  }

  // Paste: insert pasted text at cursor position
  if (key.isPasted && input) {
    // Sanitize pasted text: replace newlines with spaces for single-line input
    const sanitized = input.replace(/[\r\n]+/g, " ");
    return {
      text: text.slice(0, cursorPos) + sanitized + text.slice(cursorPos),
      cursorPos: cursorPos + sanitized.length,
      handled: true,
    };
  }

  // Typing: insert at cursor position (single character)
  if (input && !key.ctrl && !key.meta && input.length === 1) {
    return {
      text: text.slice(0, cursorPos) + input + text.slice(cursorPos),
      cursorPos: cursorPos + 1,
      handled: true,
    };
  }

  return { text, cursorPos, handled: false };
}

/**
 * Custom hook for managing text input with cursor position tracking.
 */
export function useTextInputCursor(initialText = "") {
  const [text, setText] = useState(initialText);
  const [cursorPos, setCursorPos] = useState(initialText.length);

  /**
   * Handle keyboard input for text editing.
   * @returns true if the key was handled, false otherwise
   */
  const handleKey = (input: string, key: TextInputKey): boolean => {
    const result = applyTextInputKey({ text, cursorPos }, input, key);
    if (!result.handled) {
      return false;
    }
    if (result.text !== text) {
      setText(result.text);
    }
    if (result.cursorPos !== cursorPos) {
      setCursorPos(result.cursorPos);
    }
    return true;
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
