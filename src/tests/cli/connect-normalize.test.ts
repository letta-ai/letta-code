import { describe, expect, test } from "bun:test";
import {
  isConnectApiKeyProvider,
  isConnectBedrockProvider,
  isConnectOAuthProvider,
  listConnectProvidersForHelp,
  resolveConnectProvider,
} from "../../cli/commands/connect-normalize";

describe("connect provider normalization", () => {
  test("normalizes codex alias to chatgpt provider", () => {
    const resolved = resolveConnectProvider("codex");

    expect(resolved).not.toBeNull();
    if (!resolved) {
      throw new Error("Expected codex alias to resolve");
    }
    expect(resolved?.canonical).toBe("chatgpt");
    expect(resolved?.byokId).toBe("codex");
    expect(resolved?.byokProvider.providerName).toBe("chatgpt-plus-pro");
    expect(isConnectOAuthProvider(resolved)).toBe(true);
  });

  test("resolves standard api-key providers", () => {
    const anthropic = resolveConnectProvider("anthropic");
    const openrouter = resolveConnectProvider("openrouter");

    if (!anthropic || !openrouter) {
      throw new Error("Expected anthropic and openrouter providers to resolve");
    }

    expect(anthropic?.canonical).toBe("anthropic");
    expect(isConnectApiKeyProvider(anthropic)).toBe(true);

    expect(openrouter?.canonical).toBe("openrouter");
    expect(isConnectApiKeyProvider(openrouter)).toBe(true);
  });

  test("resolves bedrock as non-api-key provider", () => {
    const bedrock = resolveConnectProvider("bedrock");
    if (!bedrock) {
      throw new Error("Expected bedrock provider to resolve");
    }

    expect(bedrock?.canonical).toBe("bedrock");
    expect(isConnectBedrockProvider(bedrock)).toBe(true);
    expect(isConnectApiKeyProvider(bedrock)).toBe(false);
  });

  test("returns null for unknown provider", () => {
    expect(resolveConnectProvider("unknown-provider")).toBeNull();
  });

  test("help list contains chatgpt alias", () => {
    expect(listConnectProvidersForHelp()).toContain("chatgpt (alias: codex)");
  });
});
