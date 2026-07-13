import { describe, expect, test } from "bun:test";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { LocalProviderRecord } from "@/backend/local/local-provider-auth-store";
import {
  createOAuthAliasProvider,
  oauthAliasDefinitionFromRecord,
} from "./pi-oauth-alias-provider";

function oauthRecord(
  name: string,
  providerType: string,
  baseUrl?: string,
): LocalProviderRecord {
  return {
    id: name,
    name,
    provider_type: providerType,
    provider_category: "byok",
    auth: {
      type: "oauth",
      access: "access",
      refresh: "refresh",
      expires: Date.now() + 60_000,
    },
    ...(baseUrl ? { base_url: baseUrl } : {}),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

describe("OAuth alias providers", () => {
  test("recognizes only custom ChatGPT and Anthropic OAuth records", () => {
    expect(
      oauthAliasDefinitionFromRecord(
        oauthRecord("chatgpt-work", "chatgpt_oauth"),
      ),
    ).toMatchObject({
      providerId: "chatgpt-work",
      canonicalProvider: "openai-codex",
      providerType: "chatgpt_oauth",
    });
    expect(
      oauthAliasDefinitionFromRecord(oauthRecord("claude-work", "anthropic")),
    ).toMatchObject({
      providerId: "claude-work",
      canonicalProvider: "anthropic",
    });
    expect(
      oauthAliasDefinitionFromRecord(
        oauthRecord("chatgpt-plus-pro", "chatgpt_oauth"),
      ),
    ).toBeUndefined();
    expect(
      oauthAliasDefinitionFromRecord(oauthRecord("other", "openai")),
    ).toBeUndefined();
  });

  test("clones canonical models under the alias without an alias header", () => {
    const canonical = openaiCodexProvider();
    const alias = createOAuthAliasProvider(
      {
        providerId: "chatgpt-work",
        canonicalProvider: "openai-codex",
        providerType: "chatgpt_oauth",
        baseUrl: "https://proxy.example.test/backend-api",
      },
      canonical,
    );

    expect(alias.id).toBe("chatgpt-work");
    expect(alias.auth.apiKey).toBeUndefined();
    expect(alias.auth.oauth).toBe(canonical.auth.oauth);
    expect(alias.headers?.["X-Letta-Provider-Alias"]).toBeUndefined();
    expect(alias.getModels().map((model) => model.id)).toEqual(
      canonical.getModels().map((model) => model.id),
    );
    expect(
      alias
        .getModels()
        .every(
          (model) =>
            model.provider === "chatgpt-work" &&
            model.baseUrl === "https://proxy.example.test/backend-api",
        ),
    ).toBe(true);
    expect(
      canonical.getModels().every((model) => model.provider === "openai-codex"),
    ).toBe(true);
  });
});
