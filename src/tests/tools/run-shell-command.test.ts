import { describe, expect, test } from "bun:test";
import { run_shell_command } from "../../tools/impl/RunShellCommandGemini";
import { LIMITS } from "../../tools/impl/truncation.js";
import { createTempRuntimeScriptCommand } from "./runtimeScript.js";

describe("RunShellCommand tool (Gemini)", () => {
  test("executes simple command", async () => {
    const result = await run_shell_command({ command: "echo 'Hello World'" });

    expect(result.message).toContain("Hello World");
  });

  test("returns success message", async () => {
    const result = await run_shell_command({ command: "echo 'test'" });

    expect(result.message).toBeTruthy();
  });

  test("executes command with description", async () => {
    const result = await run_shell_command({
      command: "echo 'test'",
      description: "Test command",
    });

    expect(result.message).toBeTruthy();
  });

  test("throws error when command is missing", async () => {
    await expect(
      run_shell_command({
        command: "",
      } as Parameters<typeof run_shell_command>[0]),
    ).rejects.toThrow(/non-empty string/);
  });

  test("truncates oversized output with overflow-file notice", async () => {
    const runtimeScript = createTempRuntimeScriptCommand(
      `process.stdout.write("x".repeat(${LIMITS.BASH_OUTPUT_CHARS + 500}))`,
    );

    try {
      const result = await run_shell_command({
        command: runtimeScript.command,
      });

      expect(result.message).toContain("[Output truncated:");
      expect(result.message).toContain("[Full output written to:");
    } finally {
      runtimeScript.cleanup();
    }
  });
});
