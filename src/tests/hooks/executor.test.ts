import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeHookCommand,
  executeHooks,
  executeHooksParallel,
} from "../../hooks/executor";
import {
  type HookCommand,
  HookExitCode,
  type PostToolUseHookInput,
  type PreToolUseHookInput,
  type SessionStartHookInput,
  type StopHookInput,
} from "../../hooks/types";

// Skip on Windows - hooks executor uses `sh -c` which doesn't exist on Windows
const isWindows = process.platform === "win32";

describe.skipIf(isWindows)("Hooks Executor", () => {
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

    test("collects feedback from blocking hooks", async () => {
      const hooks: HookCommand[] = [
        {
          type: "command",
          command: "echo 'Reason: file is dangerous' && exit 2",
        },
      ];

      const input: PreToolUseHookInput = {
        event_type: "PreToolUse",
        working_directory: tempDir,
        tool_name: "Write",
        tool_input: { file_path: "/etc/passwd" },
      };

      const result = await executeHooks(hooks, input, tempDir);

      expect(result.blocked).toBe(true);
      expect(result.feedback).toContain("Reason: file is dangerous");
    });

    test("collects error feedback from stderr", async () => {
      const hooks: HookCommand[] = [
        {
          type: "command",
          command: "echo 'Configuration error' >&2 && exit 1",
        },
      ];

      const input: PreToolUseHookInput = {
        event_type: "PreToolUse",
        working_directory: tempDir,
        tool_name: "Bash",
        tool_input: {},
      };

      const result = await executeHooks(hooks, input, tempDir);

      expect(result.errored).toBe(true);
      expect(
        result.feedback.some((f) => f.includes("Configuration error")),
      ).toBe(true);
    });
  });

  describe("executeHooksParallel", () => {
    test("executes multiple hooks in parallel", async () => {
      const hooks: HookCommand[] = [
        { type: "command", command: "echo 'parallel-1'" },
        { type: "command", command: "echo 'parallel-2'" },
        { type: "command", command: "echo 'parallel-3'" },
      ];

      const input: PreToolUseHookInput = {
        event_type: "PreToolUse",
        working_directory: tempDir,
        tool_name: "Read",
        tool_input: {},
      };

      const result = await executeHooksParallel(hooks, input, tempDir);

      expect(result.blocked).toBe(false);
      expect(result.errored).toBe(false);
      expect(result.results).toHaveLength(3);
    });

    test("aggregates results from all parallel hooks including errors", async () => {
      const hooks: HookCommand[] = [
        { type: "command", command: "echo 'result-a'" },
        { type: "command", command: "echo 'error' >&2 && exit 1" },
        { type: "command", command: "echo 'blocked' && exit 2" },
      ];

      const input: PreToolUseHookInput = {
        event_type: "PreToolUse",
        working_directory: tempDir,
        tool_name: "Write",
        tool_input: {},
      };

      const result = await executeHooksParallel(hooks, input, tempDir);

      expect(result.blocked).toBe(true);
      expect(result.errored).toBe(true);
      expect(result.results).toHaveLength(3); // All hooks ran (parallel doesn't stop early)
    });

    test("returns empty result for empty hooks array", async () => {
      const input: PreToolUseHookInput = {
        event_type: "PreToolUse",
        working_directory: tempDir,
        tool_name: "Read",
        tool_input: {},
      };

      const result = await executeHooksParallel([], input, tempDir);

      expect(result.blocked).toBe(false);
      expect(result.errored).toBe(false);
      expect(result.feedback).toEqual([]);
      expect(result.results).toEqual([]);
    });

    test("parallel execution is faster than sequential for slow hooks", async () => {
      const hooks: HookCommand[] = [
        { type: "command", command: "sleep 0.1 && echo 'a'" },
        { type: "command", command: "sleep 0.1 && echo 'b'" },
        { type: "command", command: "sleep 0.1 && echo 'c'" },
      ];

      const input: PreToolUseHookInput = {
        event_type: "PreToolUse",
        working_directory: tempDir,
        tool_name: "Read",
        tool_input: {},
      };

      const startTime = Date.now();
      const result = await executeHooksParallel(hooks, input, tempDir);
      const duration = Date.now() - startTime;

      expect(result.results).toHaveLength(3);
      // Sequential would take ~300ms, parallel should be ~100ms
      expect(duration).toBeLessThan(250);
    });
  });

  describe("Different hook input types", () => {
    test("handles PostToolUse input with tool_result", async () => {
      const hook: HookCommand = { type: "command", command: "cat" };

      const input: PostToolUseHookInput = {
        event_type: "PostToolUse",
        working_directory: tempDir,
        tool_name: "Write",
        tool_input: { file_path: "/test.txt", content: "hello" },
        tool_result: { status: "success", output: "File written" },
      };

      const result = await executeHookCommand(hook, input, tempDir);

      expect(result.exitCode).toBe(HookExitCode.ALLOW);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.event_type).toBe("PostToolUse");
      expect(parsed.tool_result.status).toBe("success");
    });

    test("handles Stop input with stop_reason", async () => {
      const hook: HookCommand = { type: "command", command: "cat" };

      const input: StopHookInput = {
        event_type: "Stop",
        working_directory: tempDir,
        stop_reason: "end_turn",
        message_count: 5,
        tool_call_count: 3,
      };

      const result = await executeHookCommand(hook, input, tempDir);

      expect(result.exitCode).toBe(HookExitCode.ALLOW);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.event_type).toBe("Stop");
      expect(parsed.stop_reason).toBe("end_turn");
    });

    test("handles SessionStart input", async () => {
      const hook: HookCommand = { type: "command", command: "cat" };

      const input: SessionStartHookInput = {
        event_type: "SessionStart",
        working_directory: tempDir,
        is_new_session: true,
        agent_id: "agent-123",
        agent_name: "Test Agent",
      };

      const result = await executeHookCommand(hook, input, tempDir);

      expect(result.exitCode).toBe(HookExitCode.ALLOW);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.event_type).toBe("SessionStart");
      expect(parsed.is_new_session).toBe(true);
      expect(parsed.agent_name).toBe("Test Agent");
    });
  });

  describe("Edge cases", () => {
    test("handles command that outputs very long output", async () => {
      // Generate a command that outputs 10KB of data
      const hook: HookCommand = {
        type: "command",
        command:
          "for i in $(seq 1 1000); do echo 'line $i: some data here'; done",
      };

      const input: PreToolUseHookInput = {
        event_type: "PreToolUse",
        working_directory: tempDir,
        tool_name: "Read",
        tool_input: {},
      };

      const result = await executeHookCommand(hook, input, tempDir);

      expect(result.exitCode).toBe(HookExitCode.ALLOW);
      expect(result.stdout.length).toBeGreaterThan(1000);
    });

    test("handles command with special characters in output", async () => {
      const hook: HookCommand = {
        type: "command",
        command: `echo '{"special": "chars: \\n\\t\\r"}'`,
      };

      const input: PreToolUseHookInput = {
        event_type: "PreToolUse",
        working_directory: tempDir,
        tool_name: "Read",
        tool_input: {},
      };

      const result = await executeHookCommand(hook, input, tempDir);

      expect(result.exitCode).toBe(HookExitCode.ALLOW);
      expect(result.stdout).toContain("special");
    });

    test("tracks duration for fast commands", async () => {
      const hook: HookCommand = { type: "command", command: "echo 'fast'" };

      const input: PreToolUseHookInput = {
        event_type: "PreToolUse",
        working_directory: tempDir,
        tool_name: "Read",
        tool_input: {},
      };

      const result = await executeHookCommand(hook, input, tempDir);

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.durationMs).toBeLessThan(1000);
    });

    test("handles hook script with complex JSON parsing", async () => {
      const scriptPath = join(tempDir, "parse-json.sh");
      writeFileSync(
        scriptPath,
        `#!/bin/bash
input=$(cat)
tool_name=$(echo "$input" | grep -o '"tool_name":"[^"]*"' | cut -d'"' -f4)
if [ "$tool_name" = "DangerousTool" ]; then
  echo "Blocked: $tool_name"
  exit 2
fi
echo "Allowed: $tool_name"
exit 0`,
        { mode: 0o755 },
      );

      const hook: HookCommand = { type: "command", command: scriptPath };

      // Test allowed
      const allowedInput: PreToolUseHookInput = {
        event_type: "PreToolUse",
        working_directory: tempDir,
        tool_name: "SafeTool",
        tool_input: {},
      };
      const allowedResult = await executeHookCommand(
        hook,
        allowedInput,
        tempDir,
      );
      expect(allowedResult.exitCode).toBe(HookExitCode.ALLOW);
      expect(allowedResult.stdout).toContain("Allowed: SafeTool");

      // Test blocked
      const blockedInput: PreToolUseHookInput = {
        event_type: "PreToolUse",
        working_directory: tempDir,
        tool_name: "DangerousTool",
        tool_input: {},
      };
      const blockedResult = await executeHookCommand(
        hook,
        blockedInput,
        tempDir,
      );
      expect(blockedResult.exitCode).toBe(HookExitCode.BLOCK);
      expect(blockedResult.stdout).toContain("Blocked: DangerousTool");
    });
  });
});
