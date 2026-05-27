import { describe, expect, test } from "bun:test";
import {
  extractUnifiedExecRunningSessionId,
  formatUnifiedExecOutputForTui,
} from "@/cli/helpers/unified-exec-output";

describe("formatUnifiedExecOutputForTui", () => {
  test("shows command output without Codex metadata", () => {
    const text = [
      "Chunk ID: abc123",
      "Wall time: 0.1234 seconds",
      "Process exited with code 0",
      "Original token count: 1",
      "Output:",
      "hello",
    ].join("\n");

    expect(formatUnifiedExecOutputForTui(text)).toBe("hello");
  });

  test("preserves non-zero exit codes", () => {
    const text = [
      "Chunk ID: abc123",
      "Wall time: 0.1234 seconds",
      "Process exited with code 7",
      "Original token count: 1",
      "Output:",
      "bad",
    ].join("\n");

    expect(formatUnifiedExecOutputForTui(text)).toBe("Exit code: 7\nbad");
  });

  test("shows running session when no output has arrived yet", () => {
    const text = [
      "Chunk ID: abc123",
      "Wall time: 0.1234 seconds",
      "Process running with session ID 4",
      "Original token count: 0",
      "Output:",
      "",
    ].join("\n");

    expect(formatUnifiedExecOutputForTui(text)).toBe(
      "Process running with session ID 4",
    );
  });

  test("keeps running session status when output is present", () => {
    const text = [
      "Chunk ID: abc123",
      "Wall time: 0.1234 seconds",
      "Process running with session ID 4",
      "Original token count: 1",
      "Output:",
      "ready",
    ].join("\n");

    expect(formatUnifiedExecOutputForTui(text)).toBe(
      "ready\nProcess running with session ID 4",
    );
  });

  test("leaves non-unified output unchanged", () => {
    expect(formatUnifiedExecOutputForTui("plain output")).toBe("plain output");
  });

  test("can hide empty completion output for background polls", () => {
    const text = [
      "Chunk ID: abc123",
      "Wall time: 0.1234 seconds",
      "Process exited with code 0",
      "Original token count: 0",
      "Output:",
      "",
    ].join("\n");

    expect(
      formatUnifiedExecOutputForTui(text, { hideEmptyCompletion: true }),
    ).toBe("");
  });

  test("extracts running session IDs from unified exec output", () => {
    const text = [
      "Chunk ID: abc123",
      "Wall time: 0.1234 seconds",
      "Process running with session ID 4",
      "Original token count: 1",
      "Output:",
      "ready",
    ].join("\n");

    expect(extractUnifiedExecRunningSessionId(text)).toBe("4");
    expect(extractUnifiedExecRunningSessionId("plain output")).toBeNull();
  });
});
