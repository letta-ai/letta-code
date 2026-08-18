import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt } from "@/agent/prompt-assets";
import { hashSystemPrompt } from "@/agent/system-prompt-versioning";
import {
  assertMemfsV2ActivationTarget,
  buildAgentConfigReport,
  buildMemfsV2AgentUpdate,
} from "@/cli/subcommands/agents";

describe("buildAgentConfigReport", () => {
  test("reports agent defaults and redacts credential fields", () => {
    const report = buildAgentConfigReport(
      {
        id: "agent-test",
        name: "Tutor",
        model: "letta/auto",
        context_window_limit: 140000,
        model_settings: {
          provider_type: "openai",
          max_output_tokens: 28000,
          api_key: "secret-key",
          auth_token: "secret-token",
        },
        llm_config: {
          context_window: 140000,
          credentials: "not-safe",
        },
        system: "compiled prompt",
      },
      null,
    );

    expect(report).toEqual({
      agent: {
        id: "agent-test",
        name: "Tutor",
        model: "letta/auto",
        context_window_limit: 140000,
        model_settings: {
          provider_type: "openai",
          max_output_tokens: 28000,
          api_key: "[redacted]",
          auth_token: "[redacted]",
        },
        llm_config: { context_window: 140000 },
      },
      conversation: null,
      effective: {
        scope: "agent",
        model: "letta/auto",
        model_settings: {
          provider_type: "openai",
          max_output_tokens: 28000,
          api_key: "[redacted]",
          auth_token: "[redacted]",
        },
      },
      note: "model is the configured handle; router handles do not identify the underlying model selected for one inference",
    });
    expect(JSON.stringify(report)).not.toContain("secret-key");
    expect(JSON.stringify(report)).not.toContain("secret-token");
    expect(JSON.stringify(report)).not.toContain("compiled prompt");
  });

  test("reports conversation overrides with their parent agent", () => {
    const report = buildAgentConfigReport(
      {
        id: "agent-test",
        model: "letta/auto",
        model_settings: { provider_type: "openai" },
      },
      {
        id: "conv-test",
        agent_id: "agent-test",
        model: "anthropic/claude-sonnet-4-6",
        model_settings: {
          provider_type: "anthropic",
          effort: "high",
        },
      },
    );

    expect(report).toMatchObject({
      agent: {
        id: "agent-test",
        model: "letta/auto",
      },
      conversation: {
        id: "conv-test",
        agent_id: "agent-test",
        model: "anthropic/claude-sonnet-4-6",
      },
      effective: {
        scope: "conversation",
        model: "anthropic/claude-sonnet-4-6",
        model_settings: {
          provider_type: "anthropic",
          effort: "high",
        },
      },
    });
  });

  test("falls back to agent defaults when the conversation has no override", () => {
    const report = buildAgentConfigReport(
      {
        id: "agent-test",
        model: "letta/auto",
        model_settings: { provider_type: "openai" },
      },
      {
        id: "conv-test",
        agent_id: "agent-test",
        model: null,
        context_window_limit: null,
      },
    );

    expect(report).toMatchObject({
      conversation: {
        id: "conv-test",
        agent_id: "agent-test",
        model: null,
        context_window_limit: null,
      },
      effective: {
        scope: "agent",
        model: "letta/auto",
        model_settings: { provider_type: "openai" },
      },
    });
  });
});

describe("buildMemfsV2AgentUpdate", () => {
  test("preserves tags and updates a managed local prompt", () => {
    const currentSystem = buildSystemPrompt("default", "local-memfs");
    const update = buildMemfsV2AgentUpdate(
      { system: currentSystem, tags: ["existing"] },
      { preset: "default", hash: hashSystemPrompt(currentSystem) },
    );

    expect(update.tags).toEqual(["existing", "memfs-v2"]);
    expect(update.managedPreset).toBe("default");
    expect(update.system).toBe(buildSystemPrompt("default", "local-memfs-v2"));
  });

  test("does not overwrite a custom prompt", () => {
    const update = buildMemfsV2AgentUpdate(
      { system: "custom prompt", tags: ["existing"] },
      { preset: "default", hash: "stale-hash" },
    );

    expect(update).toEqual({ tags: ["existing", "memfs-v2"] });
  });

  test("repairs stale metadata when the current prompt is still managed", () => {
    const currentSystem = buildSystemPrompt("default", "local-memfs");
    const update = buildMemfsV2AgentUpdate(
      { system: currentSystem, tags: ["existing"] },
      { preset: "default", hash: "stale-hash" },
    );

    expect(update.system).toBe(buildSystemPrompt("default", "local-memfs-v2"));
    expect(update.managedPreset).toBe("default");
  });

  test("adds the tag idempotently", () => {
    const update = buildMemfsV2AgentUpdate({
      system: "custom prompt",
      tags: ["memfs-v2"],
    });

    expect(update.tags).toEqual(["memfs-v2"]);
  });
});

describe("assertMemfsV2ActivationTarget", () => {
  test("ties activation to the agent memory path and converted commit", () => {
    const root = mkdtempSync(join(tmpdir(), "memfs-v2-target-"));
    const agentId = "agent-local-test";
    const memoryDir = join(root, "memfs", agentId, "memory");
    mkdirSync(memoryDir, { recursive: true });
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: memoryDir });
      execFileSync("git", ["config", "user.name", "Test Agent"], {
        cwd: memoryDir,
      });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: memoryDir,
      });
      writeFileSync(join(memoryDir, "MEMORY.md"), "# Memory\n", "utf8");
      execFileSync("git", ["add", "MEMORY.md"], { cwd: memoryDir });
      execFileSync("git", ["commit", "-m", "converted memory"], {
        cwd: memoryDir,
      });
      const memoryCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: memoryDir,
        encoding: "utf8",
      }).trim();

      expect(() =>
        assertMemfsV2ActivationTarget({
          agentId,
          memoryDir,
          memoryCommit,
          storageDir: root,
        }),
      ).not.toThrow();
      expect(() =>
        assertMemfsV2ActivationTarget({
          agentId,
          memoryDir,
          memoryCommit: "wrong-commit",
          storageDir: root,
        }),
      ).toThrow("not at the converted commit");
      const otherMemoryDir = join(root, "other-memory");
      mkdirSync(otherMemoryDir);
      expect(() =>
        assertMemfsV2ActivationTarget({
          agentId,
          memoryDir: otherMemoryDir,
          memoryCommit,
          storageDir: root,
        }),
      ).toThrow("does not belong to the requested agent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
