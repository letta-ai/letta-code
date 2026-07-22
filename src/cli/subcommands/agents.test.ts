import { describe, expect, test } from "bun:test";
import { buildAgentConfigReport } from "@/cli/subcommands/agents";

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
