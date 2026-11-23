import { useState } from "react";

interface Key {
  leftArrow?: boolean;
  rightArrow?: boolean;
  backspace?: boolean;
  delete?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  isPasted?: boolean;
}

export function useTextInputCursor(initialText = "") {
  const [text, setText] = useState(initialText);
  const [cursorPos, setCursorPos] = useState(0);

  const handleKey = (input: string, key: Key): boolean => {
    if (key.leftArrow) {
      setCursorPos((prev) => Math.max(0, prev - 1));
      return true;
    }
    if (key.rightArrow) {
      setCursorPos((prev) => Math.min(text.length, prev + 1));
      return true;
    }

    if (key.backspace || key.delete) {
      if (cursorPos > 0) {
        setText((prev) => prev.slice(0, cursorPos - 1) + prev.slice(cursorPos));
        setCursorPos((prev) => prev - 1);
      }
      return true;
    }

    if (key.isPasted && input) {
      const sanitized = input.replace(/[\r\n]+/g, " ");
      setText(
        (prev) => prev.slice(0, cursorPos) + sanitized + prev.slice(cursorPos),
      );
      setCursorPos((prev) => prev + sanitized.length);
      return true;
    }

    if (input && !key.ctrl && !key.meta && input.length === 1) {
      setText(
        (prev) => prev.slice(0, cursorPos) + input + prev.slice(cursorPos),
      );
      setCursorPos((prev) => prev + 1);
      return true;
    }

    return false;
  };

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
