import { describe, expect, test } from "bun:test";
import {
  buildByokProviderAliases,
  isByokHandleForSelector,
  labelForChatGPTByokAlias,
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
