import { describe, expect, test } from "bun:test";
import type {
  AuthorizeMcpServerWithStorageOptions,
  McpOAuthCredentialSnapshot,
} from "@/mcp-oauth-public";
import {
  type BrowserDeviceMcpOAuthRequest,
  BrowserDeviceMcpOAuthRequestError,
  connectBrowserDeviceMcpOAuth,
} from "./browser-device-mcp-oauth";

const REQUEST: BrowserDeviceMcpOAuthRequest = {
  agentId: "agent-123",
  service: "datadog",
  serverUrl: "https://mcp.datadoghq.com/v1/mcp",
};

const CREDENTIALS: McpOAuthCredentialSnapshot = {
  access_token: "access-token",
  client_id: "client-id",
  redirect_uri: "http://127.0.0.1:43210/callback",
};

describe("browser device MCP OAuth", () => {
  test("authorizes an allowlisted service and imports its credentials", async () => {
    let authorization: AuthorizeMcpServerWithStorageOptions | undefined;
    let imported:
      | {
          request: BrowserDeviceMcpOAuthRequest;
          credentials: McpOAuthCredentialSnapshot;
        }
      | undefined;
    const opened: string[] = [];

    await connectBrowserDeviceMcpOAuth(REQUEST, {
      authorize: async (options) => {
        authorization = options;
        await options.openBrowser?.(
          "https://app.datadoghq.com/oauth2/authorize?state=test",
        );
        return CREDENTIALS;
      },
      importCredentials: async (request, credentials) => {
        imported = { request, credentials };
      },
      openBrowser: async (url) => {
        opened.push(url);
      },
    });

    expect(authorization?.agentId).toBe("agent-123");
    expect(authorization?.serverName).toBe("Datadog");
    expect(authorization?.serverUrl).toBe("https://mcp.datadoghq.com/v1/mcp");
    expect(authorization?.storageNamespace).toMatch(
      /^browser-device-mcp-oauth-/,
    );
    expect(opened).toEqual([
      "https://app.datadoghq.com/oauth2/authorize?state=test",
    ]);
    expect(imported).toEqual({ request: REQUEST, credentials: CREDENTIALS });
  });

  test("clears ephemeral credentials after a successful import", async () => {
    let authorization: AuthorizeMcpServerWithStorageOptions | undefined;
    await connectBrowserDeviceMcpOAuth(REQUEST, {
      authorize: async (options) => {
        authorization = options;
        await options.storage.set(
          "temporary",
          "secret",
          new AbortController().signal,
        );
        return CREDENTIALS;
      },
      importCredentials: async () => undefined,
      openBrowser: async () => undefined,
    });

    expect(
      await authorization?.storage.get(
        "temporary",
        new AbortController().signal,
      ),
    ).toBeNull();
  });

  test("rejects unsupported agents, services, server URLs, and authorization origins", async () => {
    const dependencies = {
      authorize: async (options: AuthorizeMcpServerWithStorageOptions) => {
        await options.openBrowser?.("https://attacker.invalid/authorize");
        return CREDENTIALS;
      },
      importCredentials: async () => undefined,
      openBrowser: async () => undefined,
    };

    await expect(
      connectBrowserDeviceMcpOAuth(
        { ...REQUEST, agentId: "../../agent-123" },
        dependencies,
      ),
    ).rejects.toBeInstanceOf(BrowserDeviceMcpOAuthRequestError);
    await expect(
      connectBrowserDeviceMcpOAuth(
        { ...REQUEST, service: "github" },
        dependencies,
      ),
    ).rejects.toBeInstanceOf(BrowserDeviceMcpOAuthRequestError);
    await expect(
      connectBrowserDeviceMcpOAuth(
        { ...REQUEST, serverUrl: "https://attacker.invalid/mcp" },
        dependencies,
      ),
    ).rejects.toBeInstanceOf(BrowserDeviceMcpOAuthRequestError);
    await expect(
      connectBrowserDeviceMcpOAuth(REQUEST, dependencies),
    ).rejects.toThrow("OAuth authorization origin is not allowed");
  });

  test("accepts every catalog Datadog region and Comfy Cloud", async () => {
    const accepted = [
      "https://mcp.us3.datadoghq.com/v1/mcp",
      "https://mcp.us5.datadoghq.com/v1/mcp",
      "https://mcp.datadoghq.eu/v1/mcp",
      "https://mcp.ap1.datadoghq.com/v1/mcp",
      "https://mcp.ap2.datadoghq.com/v1/mcp",
      "https://mcp.uk1.datadoghq.com/v1/mcp",
    ];
    const dependencies = {
      authorize: async () => CREDENTIALS,
      importCredentials: async () => undefined,
      openBrowser: async () => undefined,
    };

    for (const serverUrl of accepted) {
      await expect(
        connectBrowserDeviceMcpOAuth({ ...REQUEST, serverUrl }, dependencies),
      ).resolves.toBeUndefined();
    }
    await expect(
      connectBrowserDeviceMcpOAuth(
        {
          agentId: "agent-123",
          service: "comfy",
          serverUrl: "https://cloud.comfy.org/mcp",
        },
        dependencies,
      ),
    ).resolves.toBeUndefined();
  });

  test("canonicalizes an allowlisted server URL before authorization and import", async () => {
    const serverUrls: string[] = [];
    await connectBrowserDeviceMcpOAuth(
      { ...REQUEST, serverUrl: "https://mcp.datadoghq.com/v1/mcp/" },
      {
        authorize: async (options) => {
          serverUrls.push(options.serverUrl);
          return CREDENTIALS;
        },
        importCredentials: async (request) => {
          serverUrls.push(request.serverUrl);
        },
        openBrowser: async () => undefined,
      },
    );

    expect(serverUrls).toEqual([
      "https://mcp.datadoghq.com/v1/mcp",
      "https://mcp.datadoghq.com/v1/mcp",
    ]);
  });
});
