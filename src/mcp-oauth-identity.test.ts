import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  createMcpOAuthSessionWithStorage,
  type McpOAuthStorage,
  migrateLegacyMcpOAuthCredentials,
} from "@/mcp-oauth";
import {
  hasMatchingRedirectUri,
  mcpOAuthCredentialKey,
} from "@/mcp-oauth-identity";

const AGENT_ID = "agent-oauth-identity-test";
const SERVER_NAME = "oauth-identity";

describe("MCP OAuth redirect matching", () => {
  test("accepts a stored client whose loopback redirect omits the port", async () => {
    const redirectUrl = "http://127.0.0.1:19876/callback";
    const oauth = await persistedSession(redirectUrl, [
      "http://127.0.0.1/callback",
    ]);

    expect((await oauth.authProvider.clientInformation())?.client_id).toBe(
      "registered-client",
    );
    expect(await oauth.exportCredentials()).toMatchObject({
      client_id: "registered-client",
      redirect_uri: redirectUrl,
    });
    await oauth.close();
  });

  test("still rejects a port mismatch for non-loopback redirects", async () => {
    const oauth = await persistedSession("https://app.example:8443/callback", [
      "https://app.example/callback",
    ]);

    expect(await oauth.authProvider.clientInformation()).toBeUndefined();
    await expect(oauth.exportCredentials()).rejects.toThrow(
      "MCP OAuth authorization is not complete",
    );
    await oauth.close();
  });

  test("ignores only the port for loopback redirects", () => {
    const redirect = "http://[::1]:5000/callback";
    expect(hasMatchingRedirectUri(["http://[::1]/callback"], redirect)).toBe(
      true,
    );
    expect(
      hasMatchingRedirectUri(["http://localhost/callback"], redirect),
    ).toBe(false);
    expect(hasMatchingRedirectUri(["http://[::1]/other"], redirect)).toBe(
      false,
    );
    expect(
      hasMatchingRedirectUri(
        ["https://localhost/callback"],
        "http://localhost:5000/callback",
      ),
    ).toBe(false);
  });
});

describe("MCP OAuth credential keys", () => {
  test("treats a trailing slash on a root URL as the same server", () => {
    expect(mcpOAuthCredentialKey(AGENT_ID, SERVER_NAME, "https://x.com/")).toBe(
      mcpOAuthCredentialKey(AGENT_ID, SERVER_NAME, "https://x.com"),
    );
    expect(
      mcpOAuthCredentialKey(AGENT_ID, SERVER_NAME, "https://x.com/?a=1"),
    ).not.toBe(mcpOAuthCredentialKey(AGENT_ID, SERVER_NAME, "https://x.com"));
  });

  test("migrates credentials stored under the legacy raw-URL key", async () => {
    const values = new Map<string, string>();
    const storage = memoryStorage(values);
    const legacyKey = legacyRawUrlKey("https://x.com/");
    values.set(legacyKey, "stored-credentials");

    const credentialKey = await migrateLegacyMcpOAuthCredentials(
      storage,
      AGENT_ID,
      SERVER_NAME,
      "https://x.com",
    );

    expect(credentialKey).toBe(
      mcpOAuthCredentialKey(AGENT_ID, SERVER_NAME, "https://x.com/"),
    );
    expect(credentialKey).not.toBe(legacyKey);
    expect(values.get(credentialKey)).toBe("stored-credentials");
    expect(values.has(legacyKey)).toBe(false);
  });
});

async function persistedSession(redirectUrl: string, redirectUris: string[]) {
  const values = new Map<string, string>([
    [
      "stored",
      JSON.stringify({
        redirectUrl,
        clientInformation: {
          client_id: "registered-client",
          redirect_uris: redirectUris,
        },
        tokens: { access_token: "access-token", token_type: "Bearer" },
      }),
    ],
  ]);
  const oauth = await createMcpOAuthSessionWithStorage({
    credentialKey: "stored",
    storage: memoryStorage(values),
    interactive: false,
  });
  if (!oauth) throw new Error("OAuth session was not created");
  return oauth;
}

/** Mirrors the pre-normalization key derivation, which hashed the raw URL. */
function legacyRawUrlKey(serverUrl: string): string {
  const digest = createHash("sha256")
    .update(`${AGENT_ID}\0${SERVER_NAME}\0${serverUrl}`)
    .digest("hex")
    .slice(0, 32);
  return `mcp-oauth-${digest}`;
}

function memoryStorage(values: Map<string, string>): McpOAuthStorage {
  return {
    get: async (key) => values.get(key),
    set: async (key, value) => {
      values.set(key, value);
    },
    delete: async (key) => values.delete(key),
  };
}
