// src/tests/hooks/integration.test.ts
// Integration tests for all 11 hook types

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearHooksCache,
  hasHooks,
  runNotificationHooks,
  runPermissionRequestHooks,
  runPostToolUseHooks,
  runPreCompactHooks,
  runPreToolUseHooks,
  runSessionEndHooks,
  runSessionStartHooks,
  runSetupHooks,
  runStopHooks,
  runSubagentStopHooks,
  runUserPromptSubmitHooks,
} from "../../hooks";

// Skip on Windows - hooks executor uses `sh -c` which doesn't exist on Windows
const isWindows = process.platform === "win32";

describe.skipIf(isWindows)("Hooks Integration Tests", () => {
  let tempDir: string;
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    const baseDir = join(
      tmpdir(),
      `hooks-integration-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    // Create separate directories for HOME and project to avoid double-loading
    fakeHome = join(baseDir, "home");
    tempDir = join(baseDir, "project");
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(tempDir, { recursive: true });
    // Override HOME to isolate from real global hooks
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    clearHooksCache();
  });

  afterEach(() => {
    // Restore HOME
    process.env.HOME = originalHome;
    try {
      // Clean up the parent directory
      const baseDir = join(tempDir, "..");
      rmSync(baseDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    clearHooksCache();
  });

  // Helper to create hook config
  function createHooksConfig(hooks: Record<string, unknown>) {
    const settingsDir = join(tempDir, ".letta");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      join(settingsDir, "settings.json"),
      JSON.stringify({ hooks }),
    );
  }

  // ============================================================================
  // PreToolUse Hooks
  // ============================================================================

  describe("PreToolUse hooks", () => {
    test("allows tool execution (exit 0)", async () => {
      createHooksConfig({
        PreToolUse: [
          {
            matcher: "Write",
            hooks: [{ type: "command", command: "echo 'allowed' && exit 0" }],
          },
        ],
      });

      const result = await runPreToolUseHooks(
        "Write",
        { file_path: "/test.txt", content: "hello" },
        "tool-123",
        tempDir,
      );

      expect(result.blocked).toBe(false);
      expect(result.results[0]?.stdout).toBe("allowed");
    });

    test("blocks tool execution (exit 2)", async () => {
      createHooksConfig({
        PreToolUse: [
          {
            matcher: "Write",
            hooks: [
              {
                type: "command",
                command: "echo 'Blocked: write to sensitive file' && exit 2",
              },
            ],
          },
        ],
      });

      const result = await runPreToolUseHooks(
        "Write",
        { file_path: "/etc/passwd" },
        undefined,
        tempDir,
      );

      expect(result.blocked).toBe(true);
      expect(result.feedback).toContain("Blocked: write to sensitive file");
    });

    test("matches by tool name pattern", async () => {
      createHooksConfig({
        PreToolUse: [
          {
            matcher: "Edit|Write",
            hooks: [{ type: "command", command: "echo 'file operation'" }],
          },
        ],
      });

      const editResult = await runPreToolUseHooks(
        "Edit",
        {},
        undefined,
        tempDir,
      );
      expect(editResult.results).toHaveLength(1);

      const writeResult = await runPreToolUseHooks(
        "Write",
        {},
        undefined,
        tempDir,
      );
      expect(writeResult.results).toHaveLength(1);
    });

    test("returns empty result when no hooks configured", async () => {
      const result = await runPreToolUseHooks("Bash", {}, undefined, tempDir);

      expect(result.blocked).toBe(false);
      expect(result.errored).toBe(false);
      expect(result.results).toHaveLength(0);
    });
  });

  // ============================================================================
  // PostToolUse Hooks
  // ============================================================================

  describe("PostToolUse hooks", () => {
    test("runs after tool execution", async () => {
      createHooksConfig({
        PostToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "echo 'post hook ran'" }],
          },
        ],
      });

      const result = await runPostToolUseHooks(
        "Write",
        { file_path: "/test.txt" },
        { status: "success", output: "File written" },
        "tool-456",
        tempDir,
      );

      expect(result.blocked).toBe(false);
      expect(result.results[0]?.stdout).toBe("post hook ran");
    });

    test("receives tool result in input", async () => {
      createHooksConfig({
        PostToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "cat" }],
          },
        ],
      });

      const result = await runPostToolUseHooks(
        "Bash",
        { command: "ls" },
        { status: "success", output: "file1\nfile2" },
        undefined,
        tempDir,
      );

      const parsed = JSON.parse(result.results[0]?.stdout || "{}");
      expect(parsed.tool_result?.status).toBe("success");
      expect(parsed.tool_result?.output).toBe("file1\nfile2");
    });

    test("runs hooks in parallel", async () => {
      createHooksConfig({
        PostToolUse: [
          {
            matcher: "*",
            hooks: [
              { type: "command", command: "sleep 0.1 && echo 'hook1'" },
              { type: "command", command: "sleep 0.1 && echo 'hook2'" },
            ],
          },
        ],
      });

      const start = Date.now();
      const result = await runPostToolUseHooks(
        "Read",
        {},
        { status: "success" },
        undefined,
        tempDir,
      );
      const duration = Date.now() - start;

      expect(result.results).toHaveLength(2);
      expect(duration).toBeLessThan(250); // Parallel should be ~100ms
    });
  });

  // ============================================================================
  // PermissionRequest Hooks
  // ============================================================================

  describe("PermissionRequest hooks", () => {
    test("can auto-allow permission (exit 0)", async () => {
      createHooksConfig({
        PermissionRequest: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "exit 0" }],
          },
        ],
      });

      const result = await runPermissionRequestHooks(
        "Bash",
        { command: "ls" },
        "ask",
        "session",
        tempDir,
      );

      expect(result.blocked).toBe(false);
    });

    test("can auto-deny permission (exit 2)", async () => {
      createHooksConfig({
        PermissionRequest: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: "echo 'Denied: dangerous command' && exit 2",
              },
            ],
          },
        ],
      });

      const result = await runPermissionRequestHooks(
        "Bash",
        { command: "rm -rf /" },
        "ask",
        undefined,
        tempDir,
      );

      expect(result.blocked).toBe(true);
      expect(result.feedback).toContain("Denied: dangerous command");
    });

    test("receives permission type and scope in input", async () => {
      createHooksConfig({
        PermissionRequest: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "cat" }],
          },
        ],
      });

      const result = await runPermissionRequestHooks(
        "Edit",
        { file_path: "/config.json" },
        "allow",
        "project",
        tempDir,
      );

      const parsed = JSON.parse(result.results[0]?.stdout || "{}");
      expect(parsed.permission?.type).toBe("allow");
      expect(parsed.permission?.scope).toBe("project");
    });
  });

  // ============================================================================
  // UserPromptSubmit Hooks
  // ============================================================================

  describe("UserPromptSubmit hooks", () => {
    test("runs before prompt is processed", async () => {
      createHooksConfig({
        UserPromptSubmit: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "echo 'validating prompt'" }],
          },
        ],
      });

      const result = await runUserPromptSubmitHooks(
        "Help me write code",
        false,
        "agent-123",
        "conv-456",
        tempDir,
      );

      expect(result.blocked).toBe(false);
      expect(result.results[0]?.stdout).toBe("validating prompt");
    });

    test("can block prompt submission (exit 2)", async () => {
      createHooksConfig({
        UserPromptSubmit: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: "echo 'Blocked: contains sensitive info' && exit 2",
              },
            ],
          },
        ],
      });

      const result = await runUserPromptSubmitHooks(
        "My password is secret123",
        false,
        undefined,
        undefined,
        tempDir,
      );

      expect(result.blocked).toBe(true);
    });

    test("receives prompt and command flag in input", async () => {
      createHooksConfig({
        UserPromptSubmit: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "cat" }],
          },
        ],
      });

      const result = await runUserPromptSubmitHooks(
        "/clear",
        true,
        undefined,
        undefined,
        tempDir,
      );

      const parsed = JSON.parse(result.results[0]?.stdout || "{}");
      expect(parsed.prompt).toBe("/clear");
      expect(parsed.is_command).toBe(true);
    });
  });

  // ============================================================================
  // Notification Hooks
  // ============================================================================

  describe("Notification hooks", () => {
    test("runs on notification", async () => {
      createHooksConfig({
        Notification: [
          {
            matcher: "*",
            hooks: [
              { type: "command", command: "echo 'notification received'" },
            ],
          },
        ],
      });

      const result = await runNotificationHooks(
        "Task completed",
        "info",
        tempDir,
      );

      expect(result.blocked).toBe(false);
      expect(result.results[0]?.stdout).toBe("notification received");
    });

    test("receives message and level in input", async () => {
      createHooksConfig({
        Notification: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "cat" }],
          },
        ],
      });

      const result = await runNotificationHooks(
        "Error occurred",
        "error",
        tempDir,
      );

      const parsed = JSON.parse(result.results[0]?.stdout || "{}");
      expect(parsed.message).toBe("Error occurred");
      expect(parsed.level).toBe("error");
    });

    test("runs hooks in parallel", async () => {
      createHooksConfig({
        Notification: [
          {
            matcher: "*",
            hooks: [
              { type: "command", command: "sleep 0.1 && echo 'n1'" },
              { type: "command", command: "sleep 0.1 && echo 'n2'" },
            ],
          },
        ],
      });

      const start = Date.now();
      const result = await runNotificationHooks("test", "info", tempDir);
      const duration = Date.now() - start;

      expect(result.results).toHaveLength(2);
      expect(duration).toBeLessThan(250);
    });
  });

  // ============================================================================
  // Stop Hooks
  // ============================================================================

  describe("Stop hooks", () => {
    test("runs when Claude finishes responding", async () => {
      createHooksConfig({
        Stop: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "echo 'turn complete'" }],
          },
        ],
      });

      const result = await runStopHooks("end_turn", 5, 3, tempDir);

      expect(result.results[0]?.stdout).toBe("turn complete");
    });

    test("receives stop_reason and counts in input", async () => {
      createHooksConfig({
        Stop: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "cat" }],
          },
        ],
      });

      const result = await runStopHooks("max_tokens", 10, 7, tempDir);

      const parsed = JSON.parse(result.results[0]?.stdout || "{}");
      expect(parsed.stop_reason).toBe("max_tokens");
      expect(parsed.message_count).toBe(10);
      expect(parsed.tool_call_count).toBe(7);
    });
  });

  // ============================================================================
  // SubagentStop Hooks
  // ============================================================================

  describe("SubagentStop hooks", () => {
    test("runs when subagent completes", async () => {
      createHooksConfig({
        SubagentStop: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "echo 'subagent done'" }],
          },
        ],
      });

      const result = await runSubagentStopHooks(
        "explore",
        "subagent-123",
        true,
        undefined,
        "agent-456",
        "conv-789",
        tempDir,
      );

      expect(result.results[0]?.stdout).toBe("subagent done");
    });

    test("receives subagent info in input", async () => {
      createHooksConfig({
        SubagentStop: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "cat" }],
          },
        ],
      });

      const result = await runSubagentStopHooks(
        "plan",
        "subagent-abc",
        false,
        "Task failed",
        undefined,
        undefined,
        tempDir,
      );

      const parsed = JSON.parse(result.results[0]?.stdout || "{}");
      expect(parsed.subagent_type).toBe("plan");
      expect(parsed.subagent_id).toBe("subagent-abc");
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe("Task failed");
    });
  });

  // ============================================================================
  // PreCompact Hooks
  // ============================================================================

  describe("PreCompact hooks", () => {
    test("runs before compact operation", async () => {
      createHooksConfig({
        PreCompact: [
          {
            matcher: "*",
            hooks: [
              { type: "command", command: "echo 'preparing to compact'" },
            ],
          },
        ],
      });

      const result = await runPreCompactHooks(
        50000,
        100000,
        "agent-123",
        "conv-456",
        tempDir,
      );

      expect(result.results[0]?.stdout).toBe("preparing to compact");
    });

    test("can block compact operation (exit 2)", async () => {
      createHooksConfig({
        PreCompact: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: "echo 'Cannot compact now' && exit 2",
              },
            ],
          },
        ],
      });

      const result = await runPreCompactHooks(
        10000,
        100000,
        undefined,
        undefined,
        tempDir,
      );

      expect(result.blocked).toBe(true);
      expect(result.feedback).toContain("Cannot compact now");
    });

    test("receives context info in input", async () => {
      createHooksConfig({
        PreCompact: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "cat" }],
          },
        ],
      });

      const result = await runPreCompactHooks(
        75000,
        100000,
        undefined,
        undefined,
        tempDir,
      );

      const parsed = JSON.parse(result.results[0]?.stdout || "{}");
      expect(parsed.context_length).toBe(75000);
      expect(parsed.max_context_length).toBe(100000);
    });
  });

  // ============================================================================
  // Setup Hooks
  // ============================================================================

  describe("Setup hooks", () => {
    test("runs on init", async () => {
      createHooksConfig({
        Setup: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "echo 'initializing'" }],
          },
        ],
      });

      const result = await runSetupHooks("init", tempDir);

      expect(result.results[0]?.stdout).toBe("initializing");
    });

    test("runs on maintenance", async () => {
      createHooksConfig({
        Setup: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "echo 'maintenance mode'" }],
          },
        ],
      });

      const result = await runSetupHooks("maintenance", tempDir);

      expect(result.results[0]?.stdout).toBe("maintenance mode");
    });

    test("receives init_type in input", async () => {
      createHooksConfig({
        Setup: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "cat" }],
          },
        ],
      });

      const result = await runSetupHooks("init-only", tempDir);

      const parsed = JSON.parse(result.results[0]?.stdout || "{}");
      expect(parsed.init_type).toBe("init-only");
    });
  });

  // ============================================================================
  // SessionStart Hooks
  // ============================================================================

  describe("SessionStart hooks", () => {
    test("runs when session starts", async () => {
      createHooksConfig({
        SessionStart: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "echo 'session started'" }],
          },
        ],
      });

      const result = await runSessionStartHooks(
        true,
        "agent-123",
        "Test Agent",
        "conv-456",
        tempDir,
      );

      expect(result.results[0]?.stdout).toBe("session started");
    });

    test("receives session info in input", async () => {
      createHooksConfig({
        SessionStart: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "cat" }],
          },
        ],
      });

      const result = await runSessionStartHooks(
        false,
        "agent-abc",
        "My Agent",
        "conv-xyz",
        tempDir,
      );

      const parsed = JSON.parse(result.results[0]?.stdout || "{}");
      expect(parsed.is_new_session).toBe(false);
      expect(parsed.agent_id).toBe("agent-abc");
      expect(parsed.agent_name).toBe("My Agent");
    });
  });

  // ============================================================================
  // SessionEnd Hooks
  // ============================================================================

  describe("SessionEnd hooks", () => {
    test("runs when session ends", async () => {
      createHooksConfig({
        SessionEnd: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "echo 'session ended'" }],
          },
        ],
      });

      const result = await runSessionEndHooks(
        60000,
        10,
        5,
        "agent-123",
        "conv-456",
        tempDir,
      );

      expect(result.results[0]?.stdout).toBe("session ended");
    });

    test("receives session stats in input", async () => {
      createHooksConfig({
        SessionEnd: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "cat" }],
          },
        ],
      });

      const result = await runSessionEndHooks(
        120000,
        25,
        12,
        undefined,
        undefined,
        tempDir,
      );

      const parsed = JSON.parse(result.results[0]?.stdout || "{}");
      expect(parsed.duration_ms).toBe(120000);
      expect(parsed.message_count).toBe(25);
      expect(parsed.tool_call_count).toBe(12);
    });

    test("runs hooks in parallel (fire and forget)", async () => {
      createHooksConfig({
        SessionEnd: [
          {
            matcher: "*",
            hooks: [
              { type: "command", command: "sleep 0.1 && echo 'e1'" },
              { type: "command", command: "sleep 0.1 && echo 'e2'" },
            ],
          },
        ],
      });

      const start = Date.now();
      const result = await runSessionEndHooks(
        1000,
        1,
        1,
        undefined,
        undefined,
        tempDir,
      );
      const duration = Date.now() - start;

      expect(result.results).toHaveLength(2);
      expect(duration).toBeLessThan(250);
    });
  });

  // ============================================================================
  // hasHooks Tests
  // ============================================================================

  describe("hasHooks helper", () => {
    test("returns true when hooks exist", async () => {
      createHooksConfig({
        PreToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "echo test" }],
          },
        ],
      });

      const result = await hasHooks("PreToolUse", tempDir);
      expect(result).toBe(true);
    });

    test("returns false when no hooks exist", async () => {
      createHooksConfig({});

      const result = await hasHooks("PreToolUse", tempDir);
      expect(result).toBe(false);
    });
  });

  // ============================================================================
  // Complex Scenarios
  // ============================================================================

  describe("Complex scenarios", () => {
    test("multiple hooks for same event all run", async () => {
      createHooksConfig({
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "echo 'bash specific'" }],
          },
          {
            matcher: "*",
            hooks: [{ type: "command", command: "echo 'all tools'" }],
          },
        ],
      });

      const result = await runPreToolUseHooks("Bash", {}, undefined, tempDir);

      expect(result.results).toHaveLength(2);
      expect(result.results[0]?.stdout).toBe("bash specific");
      expect(result.results[1]?.stdout).toBe("all tools");
    });

    test("first blocking hook stops subsequent hooks (sequential)", async () => {
      createHooksConfig({
        PreToolUse: [
          {
            matcher: "*",
            hooks: [
              { type: "command", command: "echo 'check 1'" },
              { type: "command", command: "echo 'BLOCKED' && exit 2" },
              { type: "command", command: "echo 'should not run'" },
            ],
          },
        ],
      });

      const result = await runPreToolUseHooks("Write", {}, undefined, tempDir);

      expect(result.blocked).toBe(true);
      expect(result.results).toHaveLength(2);
      expect(result.feedback).toContain("BLOCKED");
    });

    test("error hooks do not block subsequent hooks", async () => {
      createHooksConfig({
        PreToolUse: [
          {
            matcher: "*",
            hooks: [
              { type: "command", command: "echo 'error' >&2 && exit 1" },
              { type: "command", command: "echo 'continued'" },
            ],
          },
        ],
      });

      const result = await runPreToolUseHooks("Read", {}, undefined, tempDir);

      expect(result.blocked).toBe(false);
      expect(result.errored).toBe(true);
      expect(result.results).toHaveLength(2);
      expect(result.results[1]?.stdout).toBe("continued");
    });
  });
});
