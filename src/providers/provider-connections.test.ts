import { describe, expect, test } from "bun:test";
import type { ProviderResponse } from "@/backend/api/providers";
import type { ByokProvider } from "@/providers/byok-providers";
import { connectedRecordsForProvider } from "@/providers/provider-connections";

function providerRecord(
  name: string,
  providerType: string,
  input: Partial<ProviderResponse> = {},
): ProviderResponse {
  return {
    id: `provider-${name}`,
    name,
    provider_type: providerType,
    provider_category: "byok",
    ...input,
  };
}

describe("provider connections", () => {
  test("matches named ChatGPT OAuth providers by provider type", () => {
    const provider: ByokProvider = {
      id: "codex",
      displayName: "ChatGPT / Codex plan",
      description: "Connect your ChatGPT coding plan",
      providerType: "chatgpt_oauth",
      providerName: "chatgpt-plus-pro",
      isOAuth: true,
    };
    const connectedProviders = new Map<string, ProviderResponse>([
      [
        "openai",
        providerRecord("openai", "openai", { provider_category: "base" }),
      ],
      ["chatgpt-work", providerRecord("chatgpt-work", "chatgpt_oauth")],
    ]);

    expect(
      connectedRecordsForProvider(provider, connectedProviders, "api").map(
        (record) => record.name,
      ),
    ).toEqual(["chatgpt-work"]);
  });

  test("preserves exact provider names before same-type aliases", () => {
    const provider: ByokProvider = {
      id: "codex",
      displayName: "ChatGPT / Codex plan",
      description: "Connect your ChatGPT coding plan",
      providerType: "chatgpt_oauth",
      providerName: "chatgpt-plus-pro",
      isOAuth: true,
    };
    const connectedProviders = new Map<string, ProviderResponse>([
      ["chatgpt-work", providerRecord("chatgpt-work", "chatgpt_oauth")],
      ["chatgpt-plus-pro", providerRecord("chatgpt-plus-pro", "chatgpt_oauth")],
    ]);

    expect(
      connectedRecordsForProvider(provider, connectedProviders, "api").map(
        (record) => record.name,
      ),
    ).toEqual(["chatgpt-plus-pro", "chatgpt-work"]);
  });

  test("separates local OAuth and API-key records for the same provider type", () => {
    const oauthProvider: ByokProvider = {
      id: "anthropic-oauth",
      displayName: "Claude OAuth",
      description: "Connect Claude OAuth",
      providerType: "anthropic",
      providerName: "anthropic",
      providerNames: ["anthropic", "lc-anthropic"],
      isOAuth: true,
    };
    const apiProvider: ByokProvider = {
      id: "anthropic-api",
      displayName: "Claude API",
      description: "Connect Claude API",
      providerType: "anthropic",
      providerName: "lc-anthropic",
      providerNames: ["anthropic", "lc-anthropic"],
    };
    const connectedProviders = new Map<string, ProviderResponse>([
      [
        "anthropic",
        providerRecord("anthropic", "anthropic", { auth_type: "oauth" }),
      ],
      [
        "lc-anthropic",
        providerRecord("lc-anthropic", "anthropic", { auth_type: "api" }),
      ],
    ]);

    expect(
      connectedRecordsForProvider(
        oauthProvider,
        connectedProviders,
        "local",
      ).map((record) => record.name),
    ).toEqual(["anthropic"]);
    expect(
      connectedRecordsForProvider(apiProvider, connectedProviders, "local").map(
        (record) => record.name,
      ),
    ).toEqual(["lc-anthropic"]);
  });
});
