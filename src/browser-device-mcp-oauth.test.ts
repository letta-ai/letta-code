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

  test("propagates caller cancellation through authorization and skips import", async () => {
    const controller = new AbortController();
    let imported = false;
    const operation = connectBrowserDeviceMcpOAuth(
      REQUEST,
      {
        authorize: async (options) => {
          await new Promise<void>((_resolve, reject) => {
            const abort = (): void => reject(options.signal?.reason);
            options.signal?.addEventListener("abort", abort, { once: true });
          });
          return CREDENTIALS;
        },
        importCredentials: async () => {
          imported = true;
        },
        openBrowser: async () => undefined,
      },
      controller.signal,
    );

    controller.abort(new DOMException("Caller left", "AbortError"));
    await expect(operation).rejects.toHaveProperty("name", "AbortError");
    expect(imported).toBe(false);
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

  test("reconciles a processing handoff without ambient authorization", async () => {
    const originalFetch = globalThis.fetch;
    const submitted: Request[] = [];
    const fetchStub = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const request =
        typeof input === "string"
          ? new Request(input, init)
          : input instanceof URL
            ? new Request(input.href, init)
            : new Request(input, init);
      submitted.push(request);
      if (submitted.length === 1) {
        return new Response(
          JSON.stringify({ error: "OAuth handoff submission is in progress" }),
          { status: 409 },
        );
      }
      return new Response(
        JSON.stringify({ authorized: true, connected: true }),
        { status: 200 },
      );
    };
    globalThis.fetch = Object.assign(fetchStub, {
      preconnect: originalFetch.preconnect,
    });

    try {
      await submitBrowserDeviceMcpOAuthHandoff(
        REQUEST,
        CREDENTIALS,
        undefined,
        { retryDelayMs: 0 },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(submitted).toHaveLength(2);
    expect(submitted[1]?.url).toBe(
      "https://api.letta.com/v1/tools/mcp/browser-device-oauth/handoffs",
    );
    expect(submitted[1]?.headers.get("authorization")).toBeNull();
    expect(await submitted[1]?.json()).toEqual({
      ...CREDENTIALS,
      handoff_key: REQUEST.handoffKey,
    });
  });

  test("retries the same handoff after an ambiguous transport failure", async () => {
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    const fetchStub = async (): Promise<Response> => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("connection reset");
      return new Response(
        JSON.stringify({ authorized: true, connected: true }),
        { status: 200 },
      );
    };
    globalThis.fetch = Object.assign(fetchStub, {
      preconnect: originalFetch.preconnect,
    });

    try {
      await submitBrowserDeviceMcpOAuthHandoff(
        REQUEST,
        CREDENTIALS,
        undefined,
        { retryDelayMs: 0 },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(attempts).toBe(2);
  });

  test("keeps one absolute token expiry across handoff submission retries", async () => {
    const originalFetch = globalThis.fetch;
    const submitted: Array<Record<string, unknown>> = [];
    const fetchStub = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const request =
        input instanceof Request
          ? input
          : input instanceof URL
            ? new Request(input.href, init)
            : new Request(input, init);
      submitted.push((await request.json()) as Record<string, unknown>);
      return submitted.length === 1
        ? new Response("Bad Gateway", { status: 502 })
        : new Response(JSON.stringify({ authorized: true, connected: true }), {
            status: 200,
          });
    };
    globalThis.fetch = Object.assign(fetchStub, {
      preconnect: originalFetch.preconnect,
    });
    const wallReadings = [1_700_000_000_000, 1_700_000_030_500];
    let wallNowCalls = 0;
    try {
      await submitBrowserDeviceMcpOAuthHandoff(
        REQUEST,
        { ...CREDENTIALS, expires_in: 120 },
        undefined,
        {
          retryDelayMs: 0,
          wallNow: () => wallReadings[wallNowCalls++] ?? 1_700_000_060_000,
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(submitted).toHaveLength(2);
    expect(wallNowCalls).toBe(1);
    expect(submitted[0]).toEqual(submitted[1]);
    expect(submitted[0]).toMatchObject({
      expires_at: 1_700_000_120_000,
      handoff_key: REQUEST.handoffKey,
    });
    expect(submitted[0]).not.toHaveProperty("expires_in");
  });

  test("retries the same handoff after an admission-ambiguous gateway response", async () => {
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    const fetchStub = async (): Promise<Response> => {
      attempts += 1;
      return attempts === 1
        ? new Response("Bad Gateway", { status: 502 })
        : new Response(JSON.stringify({ authorized: true, connected: true }), {
            status: 200,
          });
    };
    globalThis.fetch = Object.assign(fetchStub, {
      preconnect: originalFetch.preconnect,
    });

    try {
      await submitBrowserDeviceMcpOAuthHandoff(
        REQUEST,
        CREDENTIALS,
        undefined,
        { retryDelayMs: 0 },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(attempts).toBe(2);
  });

  test("treats an elapsed Retry-After HTTP date as retry now", async () => {
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    const fetchStub = async (): Promise<Response> => {
      attempts += 1;
      return attempts === 1
        ? new Response("Too Many Requests", {
            headers: {
              "Retry-After": new Date(Date.now() - 1_000).toUTCString(),
            },
            status: 429,
          })
        : new Response(JSON.stringify({ authorized: true, connected: true }), {
            status: 200,
          });
    };
    globalThis.fetch = Object.assign(fetchStub, {
      preconnect: originalFetch.preconnect,
    });
    const startedAt = Date.now();

    try {
      await submitBrowserDeviceMcpOAuthHandoff(REQUEST, CREDENTIALS);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(attempts).toBe(2);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});
