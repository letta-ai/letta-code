import { describe, expect, test } from "bun:test";
import {
  buildByokProviderAliases,
  isByokHandleForSelector,
} from "../../cli/components/ModelSelector";

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

  test("preserves existing lc-* aliases", () => {
    const aliases = buildByokProviderAliases([]);

    expect(isByokHandleForSelector("lc-openai/gpt-5.4-fast", aliases)).toBe(
      true,
    );
  });
});
