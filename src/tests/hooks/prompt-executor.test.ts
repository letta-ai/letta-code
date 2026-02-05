import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { executePromptHook } from "../../hooks/prompt-executor";
import { HookExitCode, type PreToolUseHookInput, type StopHookInput } from "../../hooks/types";

// Mock getClient to avoid real API calls
const mockPost = mock(() => Promise.resolve({ content: '{"ok": true}', model: "test-model", usage: { completion_tokens: 10, prompt_tokens: 50, total_tokens: 60 } }));
const mockGetClient = mock(() => Promise.resolve({ post: mockPost }));

// Mock getCurrentAgentId
const mockGetCurrentAgentId = mock(() => "agent-test-123");

mock.module("../../agent/client", () => ({
  getClient: mockGetClient,
}));

mock.module("../../agent/context", () => ({
  getCurrentAgentId: mockGetCurrentAgentId,
}));

describe("Prompt Hook Executor", () => {
  beforeEach(() => {
    mockPost.mockClear();
    mockGetClient.mockClear();
    mockGetCurrentAgentId.mockClear();

    // Default: allow
    mockPost.mockResolvedValue({
      content: '{"ok": true}',
      model: "anthropic/claude-3-5-haiku-20241022",
      usage: { completion_tokens: 10, prompt_tokens: 50, total_tokens: 60 },
    });
  });

  afterEach(() => {
    // Clean up env vars
    delete process.env.LETTA_AGENT_ID;
  });

  describe("executePromptHook", () => {
    test("calls generate endpoint and returns ALLOW when ok is true", async () => {
      const hook = {
        type: "prompt" as const,
        prompt: "Check if this tool call is safe",
      };
      const input: PreToolUseHookInput = {
        event_type: "PreToolUse",
        working_directory: "/tmp",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        agent_id: "agent-abc-123",
      };

      const result = await executePromptHook(hook, input);

      expect(result.exitCode).toBe(HookExitCode.ALLOW);
      expect(result.timedOut).toBe(false);
      expect(mockGetClient).toHaveBeenCalledTimes(1);
      expect(mockPost).toHaveBeenCalledTimes(1);

      // Verify the correct path and body were sent
      const [path, opts] = mockPost.mock.calls[0]!;
      expect(path).toBe("/v1/agents/agent-abc-123/generate");
      expect(opts.body.prompt).toContain("Check if this tool call is safe");
      expect(opts.body.system_prompt).toBeTruthy();
      expect(opts.body.override_model).toBe("anthropic/claude-3-5-haiku-20241022");
      expect(opts.body.response_schema).toBeDefined();
      expect(opts.body.response_schema.properties.ok.type).toBe("boolean");
    });

    test("returns BLOCK when ok is false", async () => {
      mockPost.mockResolvedValue({
        content: '{"ok": false, "reason": "Dangerous command detected"}',
        model: "anthropic/claude-3-5-haiku-20241022",
        usage: { completion_tokens: 15, prompt_tokens: 50, total_tokens: 65 },
      });

      const hook = {
        type: "prompt" as const,
        prompt: "Block dangerous commands",
      };
      const input: PreToolUseHookInput = {
        event_type: "PreToolUse",
        working_directory: "/tmp",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /" },
        agent_id: "agent-abc-123",
      };

      const result = await executePromptHook(hook, input);

      expect(result.exitCode).toBe(HookExitCode.BLOCK);
      expect(result.stderr).toBe("Dangerous command detected");
    });

    test("uses custom model when specified in hook config", async () => {
      const hook = {
        type: "prompt" as const,
        prompt: "Evaluate this action",
        model: "openai/gpt-4o",
      };
      const input: PreToolUseHookInput = {
        event_type: "PreToolUse",
        working_directory: "/tmp",
        tool_name: "Edit",
        tool_input: { file_path: "/etc/passwd" },
        agent_id: "agent-abc-123",
      };

      await executePromptHook(hook, input);

      const [, opts] = mockPost.mock.calls[0]!;
      expect(opts.body.override_model).toBe("openai/gpt-4o");
    });

    test("uses custom timeout when specified", async () => {
      const hook = {
        type: "prompt" as const,
        prompt: "Evaluate this action",
        timeout: 5000,
      };
      const input: PreToolUseHookInput = {
        event_type: "PreToolUse",
        working_directory: "/tmp",
        tool_name: "Bash",
        tool_input: { command: "echo hi" },
        agent_id: "agent-abc-123",
      };

      await executePromptHook(hook, input);

      const [, opts] = mockPost.mock.calls[0]!;
      expect(opts.timeout).toBe(5000);
    });

    test("replaces $ARGUMENTS placeholder in prompt", async () => {
      const hook = {
        type: "prompt" as const,
        prompt: 'Check if tool "$ARGUMENTS" is safe to run',
      };
      const input: PreToolUseHookInput = {
        event_type: "PreToolUse",
        working_directory: "/tmp",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        agent_id: "agent-abc-123",
      };

      await executePromptHook(hook, input);

      const [, opts] = mockPost.mock.calls[0]!;
      // $ARGUMENTS should have been replaced with JSON
      expect(opts.body.prompt).not.toContain("$ARGUMENTS");
      expect(opts.body.prompt).toContain('"event_type": "PreToolUse"');
      expect(opts.body.prompt).toContain('"tool_name": "Bash"');
    });

    test("appends hook input when $ARGUMENTS is not in prompt", async () => {
      const hook = {
        type: "prompt" as const,
        prompt: "Is this tool call safe?",
      };
      const input: PreToolUseHookInput = {
        event_type: "PreToolUse",
        working_directory: "/tmp",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        agent_id: "agent-abc-123",
      };

      await executePromptHook(hook, input);

      const [, opts] = mockPost.mock.calls[0]!;
      expect(opts.body.prompt).toContain("Is this tool call safe?");
      expect(opts.body.prompt).toContain("Hook input:");
      expect(opts.body.prompt).toContain('"tool_name": "Bash"');
    });

    test("falls back to getCurrentAgentId when input has no agent_id", async () => {
      mockGetCurrentAgentId.mockReturnValue("agent-from-context");

      const hook = {
        type: "prompt" as const,
        prompt: "Check this",
      };
      const input: StopHookInput = {
        event_type: "Stop",
        working_directory: "/tmp",
        stop_reason: "end_turn",
      };

      await executePromptHook(hook, input);

      const [path] = mockPost.mock.calls[0]!;
      expect(path).toBe("/v1/agents/agent-from-context/generate");
    });

    test("falls back to LETTA_AGENT_ID env var when context unavailable", async () => {
      mockGetCurrentAgentId.mockImplementation(() => {
        throw new Error("No agent context set");
      });
      process.env.LETTA_AGENT_ID = "agent-from-env";

      const hook = {
        type: "prompt" as const,
        prompt: "Check this",
      };
      const input: StopHookInput = {
        event_type: "Stop",
        working_directory: "/tmp",
        stop_reason: "end_turn",
      };

      await executePromptHook(hook, input);

      const [path] = mockPost.mock.calls[0]!;
      expect(path).toBe("/v1/agents/agent-from-env/generate");
    });

    test("returns ERROR when no agent_id available", async () => {
      mockGetCurrentAgentId.mockImplementation(() => {
        throw new Error("No agent context set");
      });
      delete process.env.LETTA_AGENT_ID;

      const hook = {
        type: "prompt" as const,
        prompt: "Check this",
      };
      const input: StopHookInput = {
        event_type: "Stop",
        working_directory: "/tmp",
        stop_reason: "end_turn",
      };

      const result = await executePromptHook(hook, input);

      expect(result.exitCode).toBe(HookExitCode.ERROR);
      expect(result.error).toContain("agent_id");
      expect(mockPost).not.toHaveBeenCalled();
    });

    test("returns ERROR when API call fails", async () => {
      mockPost.mockRejectedValue(new Error("Network error"));

      const hook = {
        type: "prompt" as const,
        prompt: "Check this",
      };
      const input: PreToolUseHookInput = {
        event_type: "PreToolUse",
        working_directory: "/tmp",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        agent_id: "agent-abc-123",
      };

      const result = await executePromptHook(hook, input);

      expect(result.exitCode).toBe(HookExitCode.ERROR);
      expect(result.error).toContain("Network error");
    });

    test("returns ERROR when LLM returns unparseable response", async () => {
      mockPost.mockResolvedValue({
        content: "This is not valid JSON at all",
        model: "anthropic/claude-3-5-haiku-20241022",
        usage: { completion_tokens: 10, prompt_tokens: 50, total_tokens: 60 },
      });

      const hook = {
        type: "prompt" as const,
        prompt: "Check this",
      };
      const input: PreToolUseHookInput = {
        event_type: "PreToolUse",
        working_directory: "/tmp",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        agent_id: "agent-abc-123",
      };

      const result = await executePromptHook(hook, input);

      expect(result.exitCode).toBe(HookExitCode.ERROR);
      expect(result.error).toContain("Failed to parse");
    });

    test("handles JSON wrapped in markdown code blocks", async () => {
      mockPost.mockResolvedValue({
        content: '```json\n{"ok": true}\n```',
        model: "anthropic/claude-3-5-haiku-20241022",
        usage: { completion_tokens: 10, prompt_tokens: 50, total_tokens: 60 },
      });

      const hook = {
        type: "prompt" as const,
        prompt: "Check this",
      };
      const input: PreToolUseHookInput = {
        event_type: "PreToolUse",
        working_directory: "/tmp",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        agent_id: "agent-abc-123",
      };

      const result = await executePromptHook(hook, input);

      expect(result.exitCode).toBe(HookExitCode.ALLOW);
    });

    test("sends response_schema for structured output", async () => {
      const hook = {
        type: "prompt" as const,
        prompt: "Is this safe?",
      };
      const input: PreToolUseHookInput = {
        event_type: "PreToolUse",
        working_directory: "/tmp",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        agent_id: "agent-abc-123",
      };

      await executePromptHook(hook, input);

      const [, opts] = mockPost.mock.calls[0]!;
      expect(opts.body.response_schema).toEqual({
        properties: {
          ok: {
            type: "boolean",
            description: "true to allow the action, false to block it",
          },
          reason: {
            type: "string",
            description: "Explanation for the decision. Required when ok is false.",
          },
        },
        required: ["ok"],
      });
    });
  });
});
