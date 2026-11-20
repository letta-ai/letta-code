import { describe, expect, test } from "bun:test";
import { createMcpOAuthSession } from "./mcp-oauth";
import { __testOverrideLocalSecretStorage } from "./utils/secrets-store";

describe("MCP OAuth local secret storage fallback", () => {
  test("routes default MCP OAuth storage through local secret storage fallback", async () => {
    const backing = new Map<string, string>();
    __testOverrideLocalSecretStorage({
      get: async (name) => backing.get(name) ?? null,
      set: async (name, value) => {
        backing.set(name, value);
      },
      delete: async (name) => backing.delete(name),
    });
    let oauth: Awaited<ReturnType<typeof createMcpOAuthSession>> | undefined;
    try {
      oauth = await createMcpOAuthSession(
        "agent-node-fallback",
        "linear",
        "https://oauth-fallback.example/mcp",
        { interactive: true },
      );
      expect(oauth).toBeDefined();
      await oauth?.authProvider.saveTokens({
        access_token: "node-fallback-token",
        token_type: "bearer",
      });
      expect(backing.size).toBe(1);
    } finally {
      await oauth?.close();
      __testOverrideLocalSecretStorage(null);
    }
  });
});
