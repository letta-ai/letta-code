import { describe, expect, test } from "bun:test";
import {
  applyTextInputKey,
  type TextInputKey,
} from "../cli/hooks/useTextInputCursor";

type State = { text: string; cursorPos: number };

function step(state: State, input: string, key: TextInputKey): State {
  const result = applyTextInputKey(state, input, key);
  return { text: result.text, cursorPos: result.cursorPos };
}

describe("useTextInputCursor keyboard shortcuts", () => {
  test("Ctrl+A and Ctrl+E move cursor to start/end", () => {
    let state: State = { text: "hello world", cursorPos: 5 };

    state = step(state, "a", { ctrl: true });
    expect(state.cursorPos).toBe(0);

    state = step(state, "e", { ctrl: true });
    expect(state.cursorPos).toBe(11);
  });

  test("Ctrl+B and Ctrl+F move cursor left/right", () => {
    let state: State = { text: "hello", cursorPos: 2 };

    state = step(state, "b", { ctrl: true });
    expect(state.cursorPos).toBe(1);

    state = step(state, "f", { ctrl: true });
    expect(state.cursorPos).toBe(2);
  });

  test("Home and End move cursor to start/end", () => {
    let state: State = { text: "hello", cursorPos: 3 };

    state = step(state, "", { home: true });
    expect(state.cursorPos).toBe(0);

    state = step(state, "", { end: true });
    expect(state.cursorPos).toBe(5);
  });

  test("Ctrl+U deletes to start of line", () => {
    let state: State = { text: "hello world", cursorPos: 6 };

    state = step(state, "u", { ctrl: true });
    expect(state.text).toBe("world");
    expect(state.cursorPos).toBe(0);
  });

  test("Ctrl+K deletes to end of line", () => {
    let state: State = { text: "hello world", cursorPos: 5 };

    state = step(state, "k", { ctrl: true });
    expect(state.text).toBe("hello");
    expect(state.cursorPos).toBe(5);
  });

  test("Ctrl+W deletes previous word", () => {
    let state: State = { text: "hello   world test", cursorPos: 13 };

    state = step(state, "w", { ctrl: true });
    expect(state.text).toBe("hello    test");
    expect(state.cursorPos).toBe(8);
  });

  test("Delete/backspace behavior remains stable", () => {
    let state: State = { text: "abc", cursorPos: 2 };

    state = step(state, "", { backspace: true });
    expect(state.text).toBe("ac");
    expect(state.cursorPos).toBe(1);

    state = step(state, "", { delete: true });
    expect(state.text).toBe("c");
    expect(state.cursorPos).toBe(0);
  });
});
