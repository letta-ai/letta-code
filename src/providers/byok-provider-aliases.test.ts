import { describe, expect, test } from "bun:test";
import {
  BYOK_PROVIDERS,
  buildByokProviderAliases,
  isByokHandleForSelector,
} from "@/providers/byok-providers";

describe("buildByokProviderAliases", () => {
  test("derives default aliases from all built-in BYOK_PROVIDERS", () => {
    const aliases = buildByokProviderAliases([], "api");

    // Every built-in provider with a known providerType should have an alias
    for (const bp of BYOK_PROVIDERS) {
      expect(aliases[bp.providerName]).toBeDefined();
    }
  });

  test("includes all built-in lc-* providers (not just a partial set)", () => {
    const aliases = buildByokProviderAliases([], "api");

    expect(aliases["lc-anthropic"]).toBe("anthropic");
    expect(aliases["lc-openai"]).toBe("openai");
    expect(aliases["lc-zai"]).toBe("zai");
    expect(aliases["lc-gemini"]).toBe("google");
    expect(aliases["lc-minimax"]).toBe("minimax");
    expect(aliases["lc-openrouter"]).toBe("openrouter");
    expect(aliases["lc-lmstudio"]).toBe("lmstudio");
    expect(aliases["lc-llama-cpp"]).toBe("llama.cpp");
    expect(aliases["lc-bedrock"]).toBe("amazon-bedrock");
    expect(aliases["chatgpt-plus-pro"]).toBe("openai-codex");
  });

  test("layers connected providers on top of built-in aliases", () => {
    const aliases = buildByokProviderAliases(
      [{ name: "openai-sarah", provider_type: "openai" }],
      "api",
    );

    // Custom provider mapped
    expect(aliases["openai-sarah"]).toBe("openai");
    // Built-ins still present
    expect(aliases["lc-openai"]).toBe("openai");
    expect(aliases["lc-anthropic"]).toBe("anthropic");
  });

  test("maps connected LM Studio provider types to the LM Studio handle", () => {
    const aliases = buildByokProviderAliases(
      [
        { name: "lmstudio-server", provider_type: "lmstudio_openai" },
        { name: "lmstudio-legacy", provider_type: "lmstudio" },
      ],
      "api",
    );

    expect(aliases["lmstudio-server"]).toBe("lmstudio");
    expect(aliases["lmstudio-legacy"]).toBe("lmstudio");
  });

  test("handles unknown provider types gracefully", () => {
    const aliases = buildByokProviderAliases(
      [{ name: "unknown-provider", provider_type: "some_new_type" }],
      "api",
    );

    // Unknown type doesn't get an alias
    expect(aliases["unknown-provider"]).toBeUndefined();
    // Built-ins still present
    expect(aliases["lc-anthropic"]).toBe("anthropic");
  });

  test("connected provider can override a built-in alias", () => {
    const aliases = buildByokProviderAliases(
      [{ name: "lc-anthropic", provider_type: "anthropic" }],
      "api",
    );

    // Still maps correctly (same value)
    expect(aliases["lc-anthropic"]).toBe("anthropic");
  });
});

describe("isByokHandleForSelector", () => {
  const defaultAliases = buildByokProviderAliases([], "api");

  test("matches chatgpt-plus-pro/ prefix", () => {
    expect(
      isByokHandleForSelector("chatgpt-plus-pro/gpt-5", defaultAliases),
    ).toBe(true);
  });

  test("matches lc-* prefix", () => {
    expect(
      isByokHandleForSelector("lc-anthropic/claude-sonnet-4", defaultAliases),
    ).toBe(true);
  });

  test("matches known BYOK provider names via aliases", () => {
    const aliases = buildByokProviderAliases(
      [{ name: "openai-sarah", provider_type: "openai" }],
      "api",
    );

    expect(isByokHandleForSelector("openai-sarah/gpt-5-fast", aliases)).toBe(
      true,
    );
  });

  test("rejects non-BYOK Letta API handles", () => {
    expect(
      isByokHandleForSelector("anthropic/claude-sonnet-4", defaultAliases),
    ).toBe(false);
  });

  test("rejects handles without a slash", () => {
    expect(isByokHandleForSelector("somemodel", defaultAliases)).toBe(false);
  });
});
