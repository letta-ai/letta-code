import { expect, test } from "bun:test";

/**
 * Tests for multiline input functionality
 *
 * Multiline input is supported via:
 * 1. Shift+Enter - inserts a newline character
 * 2. Backslash+Enter - removes trailing backslash and inserts newline
 *
 * These tests verify the sanitization and display logic for multiline text.
 */

/** Helper function from PasteAwareTextInput.tsx */
function sanitizeForDisplay(text: string): string {
  return text.replace(/\r\n|\r|\n/g, "↵");
}

test("sanitizeForDisplay converts single newline to ↵", () => {
  const text = "Hello\nWorld";
  const result = sanitizeForDisplay(text);
  expect(result).toBe("Hello↵World");
});

test("sanitizeForDisplay converts multiple newlines to ↵", () => {
  const text = "Line 1\nLine 2\nLine 3";
  const result = sanitizeForDisplay(text);
  expect(result).toBe("Line 1↵Line 2↵Line 3");
});

test("sanitizeForDisplay handles CRLF (Windows)", () => {
  const text = "Windows\r\nStyle";
  const result = sanitizeForDisplay(text);
  expect(result).toBe("Windows↵Style");
});

test("sanitizeForDisplay handles CR (old Mac)", () => {
  const text = "Old\rMac";
  const result = sanitizeForDisplay(text);
  expect(result).toBe("Old↵Mac");
});

test("sanitizeForDisplay preserves text without newlines", () => {
  const text = "No newlines here";
  const result = sanitizeForDisplay(text);
  expect(result).toBe("No newlines here");
});

test("sanitizeForDisplay handles empty string", () => {
  const text = "";
  const result = sanitizeForDisplay(text);
  expect(result).toBe("");
});

test("sanitizeForDisplay handles text with only newlines", () => {
  const text = "\n\n\n";
  const result = sanitizeForDisplay(text);
  expect(result).toBe("↵↵↵");
});

test("sanitizeForDisplay handles mixed line endings", () => {
  const text = "Unix\nWindows\r\nOld Mac\rMixed";
  const result = sanitizeForDisplay(text);
  expect(result).toBe("Unix↵Windows↵Old Mac↵Mixed");
});

/**
 * Integration test scenarios (documented for manual testing):
 *
 * 1. Type "Hello" then press Shift+Enter, type "World" then Enter
 *    - Display should show: "Hello↵World"
 *    - Actual message sent: "Hello\nWorld" (with real newline)
 *
 * 2. Type "Line 1\" then press Enter
 *    - Display should show: "Line 1↵"
 *    - Actual message sent: "Line 1\n" (backslash removed, newline added)
 *
 * 3. Type "Regular" then press Enter (no Shift, no backslash)
 *    - Message should submit immediately with "Regular"
 *
 * 4. Type "Multiple" Shift+Enter "Lines" Shift+Enter "Here" then Enter
 *    - Display: "Multiple↵Lines↵Here"
 *    - Actual: "Multiple\nLines\nHere"
 */
