import { describe, expect, test } from "bun:test";
import { formatStatusCommandOutput } from "../../cli/helpers/statusCommand";

describe("status command output", () => {
  test("includes requested status fields when memfs is enabled", () => {
    const output = formatStatusCommandOutput({
      agentId: "agent-123",
      agentName: "Test Agent",
      conversationId: "conv-456",
      serverUrl: "https://api.letta.com",
      memfsEnabled: true,
      memoryDirectory: "/tmp/memory/agent-123",
      currentDirectory: "/repo/current",
      projectDirectory: "/repo",
      permissionMode: "default",
      modelDisplayName: "claude-sonnet-4",
    });

    expect(output).toContain("Agent ID: agent-123");
    expect(output).toContain("Agent name: Test Agent");
    expect(output).toContain("Conversation ID: conv-456");
    expect(output).toContain("Server: https://api.letta.com");
    expect(output).toContain("Memfs: on");
    expect(output).toContain("Memory directory: /tmp/memory/agent-123");
    expect(output).toContain("Current directory: /repo/current");
    expect(output).toContain("Project directory: /repo");
    expect(output).toContain("Permission mode: default");
    expect(output).toContain("Model: claude-sonnet-4");
  });

  test("shows memfs off state and unknown fallbacks", () => {
    const output = formatStatusCommandOutput({
      agentId: "agent-999",
      agentName: null,
      conversationId: "default",
      serverUrl: "http://localhost:8283",
      memfsEnabled: false,
      memoryDirectory: "/tmp/memory/agent-999",
      currentDirectory: "/workspace",
      projectDirectory: "/workspace",
      permissionMode: "plan",
      modelDisplayName: null,
    });

    expect(output).toContain("Agent name: (unnamed)");
    expect(output).toContain("Memfs: off");
    expect(output).toContain(
      "Memory directory: /tmp/memory/agent-999 (memfs off)",
    );
    expect(output).toContain("Permission mode: plan");
    expect(output).toContain("Model: unknown");
  });
});
