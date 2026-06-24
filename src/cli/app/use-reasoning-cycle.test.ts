import { describe, expect, test } from "bun:test";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import {
  resolveReasoningCycleModelHandle,
  resolveReasoningCycleTierLookupHandle,
  serviceTierForReasoningCycle,
} from "@/cli/app/use-reasoning-cycle";

describe("resolveReasoningCycleModelHandle", () => {
  test("preserves local model handles from llm_config", () => {
    expect(
      resolveReasoningCycleModelHandle(
        {
          model: "ollama/gemma4:latest",
          model_endpoint_type: "openai",
          context_window: 128000,
        },
        null,
      ),
    ).toBe("ollama/gemma4:latest");
  });

  test("uses local agent model before compatibility llm_config endpoint", () => {
    expect(
      resolveReasoningCycleModelHandle(
        {
          model: "ollama/gemma4:latest",
          model_endpoint_type: "openai",
          context_window: 128000,
        },
        "ollama/gemma4:latest",
      ),
    ).toBe("ollama/gemma4:latest");
  });

  test("keeps provider-prefixed cloud handles for non-local models", () => {
    expect(
      resolveReasoningCycleModelHandle(
        {
          model: "gpt-5.4",
          model_endpoint_type: "openai",
          context_window: 128000,
        },
        null,
      ),
    ).toBe("openai/gpt-5.4");
  });

  test("maps ChatGPT OAuth endpoint type to the model registry provider", () => {
    expect(
      resolveReasoningCycleModelHandle(
        {
          model: "gpt-5.5",
          model_endpoint_type: "chatgpt_oauth",
          context_window: 128000,
        },
        null,
      ),
    ).toBe("chatgpt-plus-pro/gpt-5.5");
  });

  test("preserves active BYOK alias handles over compatibility llm_config", () => {
    expect(
      resolveReasoningCycleModelHandle(
        {
          model: "claude-opus-4-8",
          model_endpoint_type: "anthropic",
          context_window: 200000,
        },
        null,
        "lc-anthropic/claude-opus-4-8",
      ),
    ).toBe("lc-anthropic/claude-opus-4-8");
  });

  test("preserves agent BYOK alias handles over compatibility llm_config", () => {
    expect(
      resolveReasoningCycleModelHandle(
        {
          model: "claude-opus-4-8",
          model_endpoint_type: "anthropic",
          context_window: 200000,
        },
        "lc-anthropic/claude-opus-4-8",
      ),
    ).toBe("lc-anthropic/claude-opus-4-8");
  });
});

describe("resolveReasoningCycleTierLookupHandle", () => {
  test("uses canonical Anthropic registry handles for lc-anthropic aliases", () => {
    expect(
      resolveReasoningCycleTierLookupHandle("lc-anthropic/claude-opus-4-8", {
        provider_type: "anthropic",
      } as unknown as AgentState["model_settings"]),
    ).toBe("anthropic/claude-opus-4-8");
  });

  test("keeps canonical handles unchanged", () => {
    expect(
      resolveReasoningCycleTierLookupHandle("anthropic/claude-opus-4-8", {
        provider_type: "anthropic",
      } as unknown as AgentState["model_settings"]),
    ).toBe("anthropic/claude-opus-4-8");
  });

  test("uses ChatGPT OAuth registry handles for local ChatGPT aliases", () => {
    expect(
      resolveReasoningCycleTierLookupHandle("openai-codex/gpt-5.5", {
        provider_type: "chatgpt_oauth",
      } as unknown as AgentState["model_settings"]),
    ).toBe("chatgpt-plus-pro/gpt-5.5");
  });

  test("uses ChatGPT OAuth registry handles for custom ChatGPT aliases", () => {
    expect(
      resolveReasoningCycleTierLookupHandle("chatgpt-personal/gpt-5.5", {
        provider_type: "chatgpt_oauth",
      } as unknown as AgentState["model_settings"]),
    ).toBe("chatgpt-plus-pro/gpt-5.5");
  });

  test("keeps local provider handles unchanged for fallback tiers", () => {
    expect(
      resolveReasoningCycleTierLookupHandle("lmstudio/local-model", {
        provider_type: "lmstudio_openai",
      } as unknown as AgentState["model_settings"]),
    ).toBe("lmstudio/local-model");
    expect(
      resolveReasoningCycleTierLookupHandle("llama.cpp/local-model", {
        provider_type: "llama_cpp",
      } as unknown as AgentState["model_settings"]),
    ).toBe("llama.cpp/local-model");
    expect(
      resolveReasoningCycleTierLookupHandle("ollama-cloud/local-model", {
        provider_type: "ollama_cloud",
      } as unknown as AgentState["model_settings"]),
    ).toBe("ollama-cloud/local-model");
  });
});

describe("serviceTierForReasoningCycle", () => {
  test("preserves local ChatGPT Fast priority service tier", () => {
    expect(
      serviceTierForReasoningCycle("openai-codex/gpt-5.5", {
        provider_type: "chatgpt_oauth",
        service_tier: "priority",
      } as unknown as AgentState["model_settings"]),
    ).toBe("priority");
  });

  test("clears local ChatGPT service tier when not priority", () => {
    expect(
      serviceTierForReasoningCycle("openai-codex/gpt-5.5", {
        provider_type: "chatgpt_oauth",
        service_tier: null,
      } as unknown as AgentState["model_settings"]),
    ).toBeNull();
  });

  test("preserves canonical ChatGPT priority service tier", () => {
    expect(
      serviceTierForReasoningCycle("chatgpt-plus-pro/gpt-5.5", {
        provider_type: "chatgpt_oauth",
        service_tier: "priority",
      } as unknown as AgentState["model_settings"]),
    ).toBe("priority");
  });

  test("ignores non-ChatGPT Fast-capable models", () => {
    expect(
      serviceTierForReasoningCycle("openai/gpt-5.5", {
        provider_type: "openai",
        service_tier: "priority",
      } as unknown as AgentState["model_settings"]),
    ).toBeUndefined();
  });
});
