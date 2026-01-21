import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeHookCommand, executeHooks } from "../../hooks/executor";
import { HookExitCode, type HookCommand, type PreToolUseHookInput } from "../../hooks/types";

describe("Hooks Executor", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `hooks-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("executeHookCommand", () => {
    test("executes simple echo command and returns output", async () => {
      const hook: HookCommand = {
        type: "command",
        command: "echo 'hello world'",
      };

      const input: PreToolUseHookInput = {
        event_type: "PreToolUse",
        working_directory: tempDir,
        tool_name: "Bash",
        tool_input: { command: "ls" },
      };

      const result = await executeHookCommand(hook, input, tempDir);

      expect(result.exitCode).toBe(HookExitCode.ALLOW);
      expect(result.stdout).toBe("hello world");
      expect(result.stderr).toBe("");
      expect(result.timedOut).toBe(false);
    });

    test("receives JSON input via stdin", async () => {
      // Create a script that reads stdin and outputs it
      const scriptPath = join(tempDir, "read-stdin.sh");
      writeFileSync(scriptPath, `#!/bin/bash\ncat`, { mode: 0o755 });

      const hook: HookCommand = {
        type: "command",
        command: `${scriptPath}`,
      };

      const input: PreToolUseHookInput = {
        event_type: "PreToolUse",
        working_directory: tempDir,
        tool_name: "Edit",
        tool_input: { file_path: "/test.txt" },
      };

      const result = await executeHookCommand(hook, input, tempDir);

      expect(result.exitCode).toBe(HookExitCode.ALLOW);
      const parsedOutput = JSON.parse(result.stdout);
      expect(parsedOutput.event_type).toBe("PreToolUse");
      expect(parsedOutput.tool_name).toBe("Edit");
    });

    test("returns BLOCK (exit code 2) when command exits with 2", async () => {
      const hook: HookCommand = {
        type: "command",
        command: "echo 'blocked' && exit 2",
      };

      const input: PreToolUseHookInput = {
        event_type: "PreToolUse",
        working_directory: tempDir,
        tool_name: "Write",
        tool_input: {},
      };

      const result = await executeHookCommand(hook, input, tempDir);

      expect(result.exitCode).toBe(HookExitCode.BLOCK);
      expect(result.stdout).toBe("blocked");
    });

    test("returns ERROR (exit code 1) when command fails", async () => {
      const hook: HookCommand = {
        type: "command",
        command: "echo 'error' >&2 && exit 1",
      };

      const input: PreToolUseHookInput = {
        event_type: "PreToolUse",
        working_directory: tempDir,
        tool_name: "Bash",
        tool_input: {},
      };

      const result = await executeHookCommand(hook, input, tempDir);

      expect(result.exitCode).toBe(HookExitCode.ERROR);
      expect(result.stderr).toBe("error");
    });

    test("times out and returns ERROR", async () => {
      const hook: HookCommand = {
        type: "command",
        command: "sleep 10",
        timeout: 100, // 100ms timeout
      };

      const input: PreToolUseHookInput = {
        event_type: "PreToolUse",
        working_directory: tempDir,
        tool_name: "Bash",
        tool_input: {},
      };

      const result = await executeHookCommand(hook, input, tempDir);

      expect(result.exitCode).toBe(HookExitCode.ERROR);
      expect(result.timedOut).toBe(true);
      expect(result.error).toContain("timed out");
    });

    test("receives environment variables", async () => {
      const hook: HookCommand = {
        type: "command",
        command: "echo $LETTA_HOOK_EVENT",
      };

      const input: PreToolUseHookInput = {
        event_type: "PreToolUse",
        working_directory: tempDir,
        tool_name: "Bash",
        tool_input: {},
      };

      const result = await executeHookCommand(hook, input, tempDir);

      expect(result.exitCode).toBe(HookExitCode.ALLOW);
      expect(result.stdout).toBe("PreToolUse");
    });
  });

  describe("executeHooks", () => {
    test("executes multiple hooks sequentially", async () => {
      const hooks: HookCommand[] = [
        { type: "command", command: "echo 'first'" },
        { type: "command", command: "echo 'second'" },
      ];

      const input: PreToolUseHookInput = {
        event_type: "PreToolUse",
        working_directory: tempDir,
        tool_name: "Read",
        tool_input: {},
      };

      const result = await executeHooks(hooks, input, tempDir);

      expect(result.blocked).toBe(false);
      expect(result.errored).toBe(false);
      expect(result.results).toHaveLength(2);
      expect(result.results[0]?.stdout).toBe("first");
      expect(result.results[1]?.stdout).toBe("second");
    });

    test("stops on first blocking hook", async () => {
      const hooks: HookCommand[] = [
        { type: "command", command: "echo 'allowed'" },
        { type: "command", command: "echo 'blocked' && exit 2" },
        { type: "command", command: "echo 'should not run'" },
      ];

      const input: PreToolUseHookInput = {
        event_type: "PreToolUse",
        working_directory: tempDir,
        tool_name: "Write",
        tool_input: {},
      };

      const result = await executeHooks(hooks, input, tempDir);

      expect(result.blocked).toBe(true);
      expect(result.results).toHaveLength(2); // Only first two ran
      expect(result.feedback).toContain("blocked");
    });

    test("continues after error but tracks it", async () => {
      const hooks: HookCommand[] = [
        { type: "command", command: "echo 'error' >&2 && exit 1" },
        { type: "command", command: "echo 'continued'" },
      ];

      const input: PreToolUseHookInput = {
        event_type: "PreToolUse",
        working_directory: tempDir,
        tool_name: "Bash",
        tool_input: {},
      };

      const result = await executeHooks(hooks, input, tempDir);

      expect(result.blocked).toBe(false);
      expect(result.errored).toBe(true);
      expect(result.results).toHaveLength(2);
      expect(result.results[0]?.exitCode).toBe(HookExitCode.ERROR);
      expect(result.results[1]?.exitCode).toBe(HookExitCode.ALLOW);
    });

    test("returns empty result for empty hooks array", async () => {
      const input: PreToolUseHookInput = {
        event_type: "PreToolUse",
        working_directory: tempDir,
        tool_name: "Read",
        tool_input: {},
      };

      const result = await executeHooks([], input, tempDir);

      expect(result.blocked).toBe(false);
      expect(result.errored).toBe(false);
      expect(result.results).toHaveLength(0);
    });
  });
});
