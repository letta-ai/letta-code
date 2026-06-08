import { describe, expect, test } from "bun:test";
import type { ProviderResponse } from "@/backend/api/providers";
import type { ByokProvider } from "@/providers/byok-providers";
import {
  buildConnectProviderEntries,
  resolveProviderConnectionFields,
} from "@/providers/connect-provider-service";

describe("connect provider service", () => {
  test("serializes simple providers with safe default API key fields", () => {
    const providers: ByokProvider[] = [
      {
        id: "anthropic",
        displayName: "Claude API",
        description: "Connect an Anthropic API key",
        providerType: "anthropic",
        providerName: "lc-anthropic",
        defaultApiKey: "secret-value",
      },
    ];

    const entries = buildConnectProviderEntries(providers, new Map(), "local");

    expect(entries).toEqual([
      {
        id: "anthropic",
        display_name: "Claude API",
        description: "Connect an Anthropic API key",
        provider_type: "anthropic",
        provider_name: "lc-anthropic",
        provider_names: ["lc-anthropic"],
        requires_api_key: true,
        fields: [
          {
            key: "apiKey",
            label: "API Key",
            secret: true,
            required: true,
          },
        ],
        connected: { is_connected: false },
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain("secret-value");
  });

  test("uses provider aliases and auth type to resolve connected local providers", () => {
    const providers: ByokProvider[] = [
      {
        id: "anthropic-oauth",
        displayName: "Claude OAuth",
        description: "Connect Claude OAuth",
        providerType: "anthropic",
        providerName: "anthropic",
        providerNames: ["anthropic", "lc-anthropic"],
        isOAuth: true,
        oauthProviderId: "anthropic",
      },
      {
        id: "anthropic-api",
        displayName: "Claude API",
        description: "Connect Claude API",
        providerType: "anthropic",
        providerName: "lc-anthropic",
        providerNames: ["anthropic", "lc-anthropic"],
      },
    ];
    const connected = new Map<string, ProviderResponse>([
      [
        "lc-anthropic",
        {
          id: "local-provider-lc-anthropic",
          name: "lc-anthropic",
          provider_type: "anthropic",
          provider_category: "byok",
          auth_type: "api",
          api_key: "secret-value",
          access_key: "secret-access-key",
          base_url: "https://example.test",
          region: "us-east-1",
        },
      ],
    ]);

    const entries = buildConnectProviderEntries(providers, connected, "local");

    expect(entries[0]?.connected).toEqual({ is_connected: false });
    expect(entries[1]?.connected).toEqual({
      is_connected: true,
      id: "local-provider-lc-anthropic",
      provider_name: "lc-anthropic",
      provider_type: "anthropic",
      auth_type: "api",
      base_url: "https://example.test",
      region: "us-east-1",
    });
    expect(JSON.stringify(entries)).not.toContain("secret-value");
    expect(JSON.stringify(entries)).not.toContain("secret-access-key");
  });

  test("serializes auth methods instead of default fields", () => {
    const providers: ByokProvider[] = [
      {
        id: "bedrock",
        displayName: "AWS Bedrock",
        description: "Connect Bedrock",
        providerType: "bedrock",
        providerName: "lc-bedrock",
        authMethods: [
          {
            id: "iam",
            label: "AWS Access Keys",
            description: "Enter access keys manually",
            fields: [
              { key: "accessKey", label: "Access key" },
              { key: "apiKey", label: "Secret key", secret: true },
            ],
          },
        ],
      },
    ];

    const entries = buildConnectProviderEntries(providers, new Map(), "local");

    expect(entries[0]?.fields).toBeUndefined();
    expect(entries[0]?.auth_methods).toEqual([
      {
        id: "iam",
        label: "AWS Access Keys",
        description: "Enter access keys manually",
        fields: [
          { key: "accessKey", label: "Access key" },
          { key: "apiKey", label: "Secret key", secret: true },
        ],
      },
    ]);
  });

  test("resolves simple API key fields for saving", () => {
    const provider: ByokProvider = {
      id: "anthropic",
      displayName: "Claude API",
      description: "Connect Claude API",
      providerType: "anthropic",
      providerName: "lc-anthropic",
    };

    expect(
      resolveProviderConnectionFields(provider, {
        fields: { apiKey: " sk-test ", baseUrl: " https://example.test " },
      }),
    ).toEqual({
      apiKey: "sk-test",
      options: { baseURL: "https://example.test" },
    });
  });

  test("uses provider defaults for API-key-optional providers", () => {
    const provider: ByokProvider = {
      id: "ollama",
      displayName: "Ollama",
      description: "Connect Ollama",
      providerType: "ollama",
      providerName: "ollama",
      requiresApiKey: false,
      defaultApiKey: "not-needed",
    };

    expect(resolveProviderConnectionFields(provider, { fields: {} })).toEqual({
      apiKey: "not-needed",
      options: {},
    });
  });

  test("resolves selected auth method fields", () => {
    const provider: ByokProvider = {
      id: "bedrock",
      displayName: "AWS Bedrock",
      description: "Connect Bedrock",
      providerType: "bedrock",
      providerName: "lc-bedrock",
      authMethods: [
        {
          id: "profile",
          label: "AWS Profile",
          description: "Use an AWS profile",
          fields: [
            { key: "profile", label: "Profile Name" },
            { key: "region", label: "AWS Region" },
          ],
        },
      ],
    };

    expect(
      resolveProviderConnectionFields(provider, {
        authMethodId: "profile",
        fields: { profile: " default ", region: " us-east-1 " },
      }),
    ).toEqual({
      apiKey: "",
      profile: "default",
      region: "us-east-1",
      options: {},
    });
  });

  test("rejects unsupported OAuth save path", () => {
    const provider: ByokProvider = {
      id: "codex",
      displayName: "ChatGPT / Codex plan",
      description: "Connect ChatGPT",
      providerType: "chatgpt_oauth",
      providerName: "chatgpt-plus-pro",
      isOAuth: true,
    };

    expect(() =>
      resolveProviderConnectionFields(provider, { fields: {} }),
    ).toThrow("uses OAuth");
  });

  test("requires all selected auth method fields", () => {
    const provider: ByokProvider = {
      id: "bedrock",
      displayName: "AWS Bedrock",
      description: "Connect Bedrock",
      providerType: "bedrock",
      providerName: "lc-bedrock",
      authMethods: [
        {
          id: "profile",
          label: "AWS Profile",
          description: "Use an AWS profile",
          fields: [
            { key: "profile", label: "Profile Name" },
            { key: "region", label: "AWS Region" },
          ],
        },
      ],
    };

    expect(() =>
      resolveProviderConnectionFields(provider, {
        authMethodId: "profile",
        fields: { profile: "default" },
      }),
    ).toThrow("Missing AWS Region");
  });
});
