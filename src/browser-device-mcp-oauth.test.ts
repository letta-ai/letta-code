import { describe, expect, test } from "bun:test";
import type {
  AuthorizeMcpServerWithStorageOptions,
  McpOAuthCredentialSnapshot,
} from "@/mcp-oauth-public";
import {
  type BrowserDeviceMcpOAuthRequest,
  BrowserDeviceMcpOAuthRequestError,
  connectBrowserDeviceMcpOAuth,
  submitBrowserDeviceMcpOAuthHandoff,
} from "./browser-device-mcp-oauth";

const REQUEST: BrowserDeviceMcpOAuthRequest = {
  handoffKey: "h".repeat(43),
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

    expect(authorization?.agentId).toMatch(/^browser-device-[a-f0-9]{32}$/);
    expect(authorization?.serverName).toBe("Datadog");
    expect(authorization?.serverUrl).toBe("https://mcp.datadoghq.com/v1/mcp");
    expect(authorization?.storageNamespace).toMatch(
      /^browser-device-mcp-oauth-/,
    );
    expect(authorization?.fetch).toEqual(expect.any(Function));
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

  test("rejects invalid handoffs, services, server URLs, and authorization origins", async () => {
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
        { ...REQUEST, handoffKey: "too-short" },
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

  test("limits provider network requests to known HTTPS origins", async () => {
    await expect(
      connectBrowserDeviceMcpOAuth(REQUEST, {
        authorize: async (options) => {
          await options.fetch?.("http://127.0.0.1/internal");
          return CREDENTIALS;
        },
        importCredentials: async () => undefined,
        openBrowser: async () => undefined,
        providerFetch: async () => new Response(null, { status: 200 }),
      }),
    ).rejects.toThrow("OAuth provider URL is not allowed");

    const requested: string[] = [];
    await connectBrowserDeviceMcpOAuth(REQUEST, {
      authorize: async (options) => {
        await options.fetch?.("https://mcp.datadoghq.com/v1/mcp");
        return CREDENTIALS;
      },
      importCredentials: async () => undefined,
      openBrowser: async () => undefined,
      providerFetch: async (input) => {
        requested.push(String(input));
        return new Response(null, { status: 200 });
      },
    });
    expect(requested).toEqual(["https://mcp.datadoghq.com/v1/mcp"]);
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
          handoffKey: "c".repeat(43),
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

  test("pairs each Datadog MCP region with only its matching app origin", async () => {
    const regions = [
      ["https://mcp.datadoghq.com/v1/mcp", "https://app.datadoghq.com"],
      ["https://mcp.us3.datadoghq.com/v1/mcp", "https://us3.datadoghq.com"],
      ["https://mcp.us5.datadoghq.com/v1/mcp", "https://us5.datadoghq.com"],
      ["https://mcp.datadoghq.eu/v1/mcp", "https://app.datadoghq.eu"],
      ["https://mcp.ap1.datadoghq.com/v1/mcp", "https://ap1.datadoghq.com"],
      ["https://mcp.ap2.datadoghq.com/v1/mcp", "https://ap2.datadoghq.com"],
      ["https://mcp.uk1.datadoghq.com/v1/mcp", "https://uk1.datadoghq.com"],
    ] as const;

    for (const [serverUrl, appOrigin] of regions) {
      await expect(
        connectBrowserDeviceMcpOAuth(
          { ...REQUEST, serverUrl },
          {
            authorize: async (options) => {
              await options.openBrowser?.(`${appOrigin}/oauth2/authorize`);
              return CREDENTIALS;
            },
            importCredentials: async () => undefined,
            openBrowser: async () => undefined,
          },
        ),
      ).resolves.toBeUndefined();
    }

    await expect(
      connectBrowserDeviceMcpOAuth(
        { ...REQUEST, serverUrl: "https://mcp.us3.datadoghq.com/v1/mcp" },
        {
          authorize: async (options) => {
            await options.openBrowser?.(
              "https://app.datadoghq.com/oauth2/authorize",
            );
            return CREDENTIALS;
          },
          importCredentials: async () => undefined,
          openBrowser: async () => undefined,
        },
      ),
    ).rejects.toThrow("OAuth authorization origin is not allowed");
  });

  test("submits with the handoff key and no ambient authorization", async () => {
    const originalFetch = globalThis.fetch;
    let submitted: Request | undefined;
    const fetchStub = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      submitted =
        typeof input === "string"
          ? new Request(input, init)
          : input instanceof URL
            ? new Request(input.href, init)
            : new Request(input, init);
      return new Response(
        JSON.stringify({ authorized: true, connected: true }),
        { status: 200 },
      );
    };
    globalThis.fetch = Object.assign(fetchStub, {
      preconnect: originalFetch.preconnect,
    });

    try {
      await submitBrowserDeviceMcpOAuthHandoff(REQUEST, CREDENTIALS);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(submitted?.url).toBe(
      "https://api.letta.com/v1/tools/mcp/browser-device-oauth/handoffs",
    );
    expect(submitted?.headers.get("authorization")).toBeNull();
    expect(await submitted?.json()).toEqual({
      ...CREDENTIALS,
      handoff_key: REQUEST.handoffKey,
    });
  });
});
