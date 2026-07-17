import { describe, expect, test } from "bun:test";
import { getReasoningTierOptionsForHandle } from "@/agent/model";
import {
  buildByokProviderAliases,
  isByokHandleForSelector,
  labelForBackendModel,
  labelForChatGPTByokAlias,
  registryHandleForBackendModel,
  registryHandleForByokAlias,
  toByokSelectorModel,
} from "@/cli/components/ModelSelector";

describe("ModelSelector custom BYOK provider detection", () => {
  test("treats connected custom OpenAI providers as BYOK", () => {
    const aliases = buildByokProviderAliases([
      {
        name: "openai-sarah",
        provider_type: "openai",
      },
    ]);

    expect(aliases["openai-sarah"]).toBe("openai");
    expect(isByokHandleForSelector("openai-sarah/gpt-5.4-fast", aliases)).toBe(
      true,
    );
  });

  test("maps custom OpenAI provider handles back to base openai handles", () => {
    const aliases = buildByokProviderAliases([
      {
        name: "openai-sarah",
        provider_type: "openai",
      },
    ]);

    const provider = "openai-sarah";
    const model = "gpt-5.4-fast";
    const baseProvider = aliases[provider];

    expect(`${baseProvider}/${model}`).toBe("openai/gpt-5.4-fast");
  });

  test("maps custom ChatGPT OAuth provider handles back to Codex registry handles", () => {
    const aliases = buildByokProviderAliases([
      {
        name: "chatgpt-personal",
        provider_type: "chatgpt_oauth",
      },
    ]);

    expect(aliases["chatgpt-personal"]).toBe("openai-codex");
    expect(isByokHandleForSelector("chatgpt-personal/gpt-5.5", aliases)).toBe(
      true,
    );
  });

  test("uses ChatGPT GPT-5.6 metadata for available variants", () => {
    expect(
      registryHandleForBackendModel(
        "openai-codex/gpt-5.6-sol",
        "chatgpt_oauth",
      ),
    ).toBe("chatgpt-plus-pro/gpt-5.6-sol");
    expect(
      registryHandleForBackendModel(
        "openai-codex/gpt-5.6-luna",
        "chatgpt_oauth",
      ),
    ).toBe("chatgpt-plus-pro/gpt-5.6-luna");
    expect(labelForBackendModel("GPT-5.6 Sol", "chatgpt_oauth")).toBe(
      "GPT-5.6 Sol (ChatGPT)",
    );
    expect(labelForBackendModel("GPT-5.6 Sol (ChatGPT)", "chatgpt_oauth")).toBe(
      "GPT-5.6 Sol (ChatGPT)",
    );
  });

  test("resolves alias-backed BYOK handles to registry handles for reasoning tiers", () => {
    const aliases = buildByokProviderAliases([
      {
        name: "chatgpt-personal",
        provider_type: "chatgpt_oauth",
      },
      {
        name: "openai-sarah",
        provider_type: "openai",
      },
    ]);

    expect(
      registryHandleForByokAlias("chatgpt-personal/gpt-5.5", aliases),
    ).toBe("chatgpt-plus-pro/gpt-5.5");
    expect(registryHandleForByokAlias("openai-sarah/gpt-5.5", aliases)).toBe(
      "openai/gpt-5.5",
    );
    expect(registryHandleForByokAlias("lc-moonshot/kimi-k3", aliases)).toBe(
      "moonshot/kimi-k3",
    );

    const reasoningOptions = getReasoningTierOptionsForHandle(
      registryHandleForByokAlias("chatgpt-personal/gpt-5.5", aliases),
    );
    expect(reasoningOptions.map((option) => option.effort)).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  test("keeps alias handles while carrying canonical registry metadata", () => {
    const aliases = buildByokProviderAliases([
      {
        name: "chatgpt-personal",
        provider_type: "chatgpt_oauth",
      },
    ]);

    const model = toByokSelectorModel(
      {
        id: "gpt-5.5-plus-pro-high",
        handle: "chatgpt-plus-pro/gpt-5.5",
        label: "GPT-5.5 (ChatGPT)",
        description: "OpenAI's most capable model",
        updateArgs: { reasoning_effort: "high" },
      },
      "chatgpt-personal/gpt-5.5",
      aliases,
      { reasoning_effort: "high", provider_type: "chatgpt_oauth" },
    );

    expect(model).toMatchObject({
      id: "chatgpt-personal/gpt-5.5",
      handle: "chatgpt-personal/gpt-5.5",
      registryHandle: "chatgpt-plus-pro/gpt-5.5",
      label: "GPT-5.5 (chatgpt-personal)",
      updateArgs: {
        reasoning_effort: "high",
        provider_type: "chatgpt_oauth",
      },
    });
  });

  test("uses ChatGPT OAuth provider aliases in recommended BYOK labels", () => {
    const aliases = buildByokProviderAliases([
      {
        name: "chatgpt-personal",
        provider_type: "chatgpt_oauth",
      },
    ]);

    expect(
      labelForChatGPTByokAlias(
        "GPT-5.5 (ChatGPT)",
        "chatgpt-personal/gpt-5.5",
        aliases,
      ),
    ).toBe("GPT-5.5 (chatgpt-personal)");

    expect(
      labelForChatGPTByokAlias("GPT-5.5", "openai-sarah/gpt-5.5", {
        "openai-sarah": "openai",
      }),
    ).toBe("GPT-5.5");
  });

  test("preserves existing lc-* aliases", () => {
    const aliases = buildByokProviderAliases([]);

    expect(isByokHandleForSelector("lc-openai/gpt-5.4-fast", aliases)).toBe(
      true,
    );
  });
});
