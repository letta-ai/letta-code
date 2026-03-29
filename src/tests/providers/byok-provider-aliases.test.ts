import { describe, expect, test } from "bun:test";
import {
  BYOK_PROVIDERS,
  buildByokProviderAliases,
  isByokHandleForSelector,
} from "../../providers/byok-providers";

describe("buildByokProviderAliases", () => {
  test("derives default aliases from all built-in BYOK_PROVIDERS", () => {
    const aliases = buildByokProviderAliases();

    // Every built-in provider with a known providerType should have an alias
    for (const bp of BYOK_PROVIDERS) {
      expect(aliases[bp.providerName]).toBeDefined();
    }
  });

  test("includes all built-in lc-* providers (not just a partial set)", () => {
    const aliases = buildByokProviderAliases();

    expect(aliases["lc-anthropic"]).toBe("anthropic");
    expect(aliases["lc-openai"]).toBe("openai");
    expect(aliases["lc-zai"]).toBe("zai");
    expect(aliases["lc-gemini"]).toBe("google_ai");
    expect(aliases["lc-minimax"]).toBe("minimax");
    expect(aliases["lc-openrouter"]).toBe("openrouter");
    expect(aliases["lc-bedrock"]).toBe("bedrock");
    expect(aliases["chatgpt-plus-pro"]).toBe("chatgpt-plus-pro");
  });

  test("layers connected providers on top of built-in aliases", () => {
    const aliases = buildByokProviderAliases([
      { name: "openai-sarah", provider_type: "openai" },
    ]);

    // Custom provider mapped
    expect(aliases["openai-sarah"]).toBe("openai");
    // Built-ins still present
    expect(aliases["lc-openai"]).toBe("openai");
    expect(aliases["lc-anthropic"]).toBe("anthropic");
  });

  test("handles unknown provider types gracefully", () => {
    const aliases = buildByokProviderAliases([
      { name: "unknown-provider", provider_type: "some_new_type" },
    ]);

    // Unknown type doesn't get an alias
    expect(aliases["unknown-provider"]).toBeUndefined();
    // Built-ins still present
    expect(aliases["lc-anthropic"]).toBe("anthropic");
  });

  test("connected provider can override a built-in alias", () => {
    const aliases = buildByokProviderAliases([
      { name: "lc-anthropic", provider_type: "anthropic" },
    ]);

    // Still maps correctly (same value)
    expect(aliases["lc-anthropic"]).toBe("anthropic");
  });
});

describe("isByokHandleForSelector", () => {
  const defaultAliases = buildByokProviderAliases();

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
    const aliases = buildByokProviderAliases([
      { name: "openai-sarah", provider_type: "openai" },
    ]);

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
