import { describe, expect, spyOn, test } from "bun:test";
import { resetMcpOriginatorAuthority } from "@/agent/mcp-originator-authority";
import {
  clearMcpOriginatorTokens,
  setMcpOriginatorToken,
} from "@/agent/mcp-originator-tokens";
import type { EnvironmentConnection } from "@/backend/api/environments";
import {
  createAgentSandbox,
  getTeleportStatus,
  listEnvironments,
  resolveDesktopEnvironmentConnectionId,
  resolveEnvironmentConnectionId,
  teleportToEnvironment,
} from "@/backend/api/environments";
import {
  createMcpSubprocessBroker,
  createMcpSubprocessBrokerClient,
} from "@/backend/api/mcp-subprocess-broker";
import type { apiRequest } from "@/backend/api/request";
import { runWithRuntimeContext } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";

test("reads the scoped teleport receipt without starting a handoff", async () => {
  const calls: unknown[][] = [];
  const request = (async (...args: unknown[]) => {
    calls.push(args);
    return { status: "completed" };
  }) as typeof apiRequest;
  expect(
    (await getTeleportStatus("agent/1", "conv/1", "teleport/1", request))
      .status,
  ).toBe("completed");
  expect(calls[0]?.slice(0, 2)).toEqual([
    "GET",
    "/v1/environments/runtimes/agent%2F1/conv%2F1/teleports/teleport%2F1",
  ]);
  expect(calls[0]?.[3]).toMatchObject({ signal: expect.any(AbortSignal) });
});

function environment(
  overrides: Partial<EnvironmentConnection> = {},
): EnvironmentConnection {
  const now = Date.now();
  return {
    id: "env-1",
    connectionId: "conn-1",
    deviceId: "device-1",
    connectionName: "Environment",
    organizationId: "org-1",
    podId: "pod-1",
    connectedAt: now,
    lastHeartbeat: now,
    lastSeenAt: now,
    firstSeenAt: now,
    ...overrides,
  };
}

describe("Computer environment resolution", () => {
  function listConnections(
    connections: EnvironmentConnection[],
  ): typeof listEnvironments {
    return async (options) => {
      expect(options).toEqual({ limit: 100 });
      return { connections, hasNextPage: false };
    };
  }

  test.each(["device-1", " Environment "])(
    "selects the freshest online listener for %s on one device",
    async (selector) => {
      const now = Date.now();
      const heartbeat = environment({
        lastHeartbeat: now - 1_000,
        lastSeenAt: now - 10_000,
      });
      const seen = environment({
        id: "env-2",
        connectionId: "conn-2",
        lastHeartbeat: now - 5_000,
        lastSeenAt: now,
      });
      const offline = environment({
        id: "env-3",
        connectionId: "conn-3",
        lastHeartbeat: now - 180_000,
        lastSeenAt: now + 1_000,
      });
      for (const connections of [
        [heartbeat, seen, offline],
        [offline, seen, heartbeat],
      ]) {
        expect(
          await resolveEnvironmentConnectionId(
            selector,
            listConnections(connections),
          ),
        ).toEqual({ connectionId: "conn-2", environment: seen });
      }
      seen.lastSeenAt = now - 20_000;
      expect(
        await resolveEnvironmentConnectionId(
          selector,
          listConnections([seen, heartbeat]),
        ),
      ).toEqual({ connectionId: "conn-1", environment: heartbeat });
    },
  );

  test("rejects a shared name across distinct online devices", async () => {
    const list = listConnections([
      environment(),
      environment({
        id: "env-2",
        connectionId: "conn-2",
        deviceId: "device-2",
      }),
    ]);
    await expect(
      resolveEnvironmentConnectionId("Environment", list),
    ).rejects.toThrow('Computer "Environment" is ambiguous');
  });

  test.each(["conn-1", "env-1"])(
    "pins explicit listener selector %s even with a fresher sibling",
    async (selector) => {
      const pinned = environment({
        lastHeartbeat: Date.now() - 10_000,
        lastSeenAt: 0,
      });
      const list = listConnections([
        pinned,
        environment({ id: "env-2", connectionId: "conn-2" }),
      ]);
      expect(await resolveEnvironmentConnectionId(selector, list)).toEqual({
        connectionId: "conn-1",
        environment: pinned,
      });
      pinned.lastHeartbeat = Date.now() - 180_000;
      await expect(
        resolveEnvironmentConnectionId(selector, list),
      ).rejects.toThrow("is offline");
    },
  );

  test("rejects offline devices even with a recent lastSeenAt", async () => {
    const list = listConnections([
      environment({ lastHeartbeat: Date.now() - 180_000 }),
      environment({ id: "env-2", connectionId: null, lastHeartbeat: null }),
    ]);
    await expect(
      resolveEnvironmentConnectionId("device-1", list),
    ).rejects.toThrow("is offline");
  });

  test("preserves missing and empty selector errors", async () => {
    await expect(
      resolveEnvironmentConnectionId("missing", listConnections([])),
    ).rejects.toThrow("not found");
    await expect(
      resolveEnvironmentConnectionId("  ", async () => {
        throw new Error("must not list for an empty selector");
      }),
    ).rejects.toThrow("Computer selector must not be empty");
  });
});

describe("Cloud sandbox environment resolution", () => {
  test("sends conversationId in the create request body", async () => {
    const calls: Array<{
      method: string;
      path: string;
      body?: Record<string, unknown>;
    }> = [];
    const request = (async (
      method: string,
      path: string,
      body?: Record<string, unknown>,
    ) => {
      calls.push({ method, path, body });
      return {
        sandboxId: "sandbox-1",
        deviceId: "device-1",
        connectionName: "Cloud",
      };
    }) as typeof apiRequest;

    await createAgentSandbox("agent-1", { conversationId: "conv-1" }, request);

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/v1/agents/agent-1/sandboxes",
        body: { conversationId: "conv-1" },
      },
    ]);
  });

  test("keeps the virtual default conversation agent-scoped", async () => {
    const bodies: Array<Record<string, unknown> | undefined> = [];
    const request = (async (
      _method: string,
      _path: string,
      body?: Record<string, unknown>,
    ) => {
      bodies.push(body);
      return {
        sandboxId: "sandbox-1",
        deviceId: "device-1",
        connectionName: "Cloud",
      };
    }) as typeof apiRequest;

    await createAgentSandbox("agent-1", { conversationId: "default" }, request);

    expect(bodies).toEqual([{}]);
  });
});

describe("Desktop environment resolution", () => {
  test("resolves the one online Desktop listener to its Cloud lease", async () => {
    const list = (async (options) => {
      expect(options).toEqual({ limit: 100, onlineOnly: true });
      return {
        connections: [
          environment({
            connectionId: "conn-desktop",
            listenerInstanceId: "desktop-direct-cloud:install-1",
            connectionName: "Caren's Mac",
          }),
          environment({
            id: "env-server",
            connectionId: "conn-server",
            listenerInstanceId: "desktop-primary:install-1",
          }),
        ],
        hasNextPage: false,
      };
    }) as typeof listEnvironments;

    const result = await resolveDesktopEnvironmentConnectionId(list);

    expect(result.connectionId).toBe("conn-desktop");
    expect(result.environment.connectionName).toBe("Caren's Mac");
  });

  test("requires the Desktop computer to be online", async () => {
    const list = (async () => ({
      connections: [
        environment({
          connectionId: null,
          listenerInstanceId: "desktop-direct-cloud:install-1",
          lastHeartbeat: null,
        }),
      ],
      hasNextPage: false,
    })) as typeof listEnvironments;

    await expect(resolveDesktopEnvironmentConnectionId(list)).rejects.toThrow(
      "No Desktop Local computer is online",
    );
  });

  test("requires an explicit target when several Desktops are online", async () => {
    const list = (async () => ({
      connections: [
        environment({
          connectionId: "conn-desktop-1",
          listenerInstanceId: "desktop-direct-cloud:install-1",
          connectionName: "MacBook",
        }),
        environment({
          id: "env-2",
          connectionId: "conn-desktop-2",
          listenerInstanceId: "desktop-direct-cloud:install-2",
          connectionName: "Mac Mini",
        }),
      ],
      hasNextPage: false,
    })) as typeof listEnvironments;

    await expect(resolveDesktopEnvironmentConnectionId(list)).rejects.toThrow(
      "Multiple Desktop computers are online",
    );
  });

  test("resolves the account-scoped direct primary without a Remote Access sibling", async () => {
    const list = (async () => ({
      connections: [
        environment({
          deviceId: "desktop:installation:user-1",
          listenerInstanceId: "desktop-primary:installation",
          connectionId: "conn-primary",
        }),
      ],
      hasNextPage: false,
    })) as typeof listEnvironments;
    expect(
      (await resolveDesktopEnvironmentConnectionId(list)).connectionId,
    ).toBe("conn-primary");
  });
});

describe("teleportToEnvironment", () => {
  test("POSTs to the teleport endpoint with targetConnectionId and idempotencyKey", async () => {
    const calls: Array<{
      method: string;
      path: string;
      body?: Record<string, unknown>;
    }> = [];
    const request = (async (
      method: string,
      path: string,
      body?: Record<string, unknown>,
    ): Promise<unknown> => {
      calls.push({ method, path, body });
      return {
        id: "teleport-1",
        agentId: "agent-1",
        conversationId: "conv-1",
        sourceConnectionId: "conn-source",
        targetConnectionId: "conn-target",
        targetDeviceId: "device-target",
        targetConnectionName: "Target",
        status: "waiting_for_source",
        error: null,
        createdAt: 1,
        updatedAt: 1,
      };
    }) as typeof apiRequest;

    const result = await teleportToEnvironment(
      "agent-1",
      "conv-1",
      "conn-target",
      request,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe(
      "/v1/environments/runtimes/agent-1/conv-1/teleport",
    );
    expect(calls[0]?.body?.targetConnectionId).toBe("conn-target");
    expect(calls[0]?.body?.idempotencyKey).toEqual(expect.any(String));
    expect(result.status).toBe("waiting_for_source");
    expect(result.targetConnectionId).toBe("conn-target");
  });
});

test("environment discovery forwards held originator proof and omits absent proof", async () => {
  const headers: Headers[] = [];
  const settings = spyOn(
    settingsManager,
    "getSettingsWithSecureTokens",
  ).mockResolvedValue({
    env: { LETTA_BASE_URL: "https://example.com", LETTA_API_KEY: "test-key" },
  } as unknown as Awaited<
    ReturnType<typeof settingsManager.getSettingsWithSecureTokens>
  >);
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async (
    _url,
    init,
  ) => {
    headers.push(new Headers(init?.headers));
    return new Response(
      JSON.stringify({ connections: [], hasNextPage: false }),
    );
  }) as typeof fetch);
  setMcpOriginatorToken("environment-test-held", "test-originator");
  try {
    for (const id of [
      "environment-test-held",
      "environment-test-missing",
      undefined,
    ]) {
      await runWithRuntimeContext({ mcpOriginatorSuperRunId: id }, () =>
        listEnvironments(),
      );
    }
    expect(headers.map((h) => h.get("x-letta-mcp-originator-token"))).toEqual([
      "test-originator",
      null,
      null,
    ]);
    expect(
      headers.map((h) => h.get("x-letta-mcp-originator-isolation")),
    ).toEqual(["1", null, null]);
  } finally {
    fetchMock.mockRestore();
    settings.mockRestore();
    clearMcpOriginatorTokens();
    resetMcpOriginatorAuthority();
  }
});

test("aborts a pending teleport status request through the broker promptly", async () => {
  const controller = new AbortController();
  const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(
    controller.signal,
  );
  let finishUpstream!: (value: unknown) => void;
  const upstream = new Promise((resolve) => {
    finishUpstream = resolve;
  });
  const broker = createMcpSubprocessBroker({
    agentId: "agent-1",
    getScope: () => ({ agentId: "agent-1" }),
    getClient: async () => ({
      get: async () => {
        controller.abort();
        return upstream;
      },
      post: async () => ({}),
    }),
  });
  const previous = Object.fromEntries(
    Object.keys(broker.env).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, broker.env);
  try {
    const started = Date.now();
    await expect(
      getTeleportStatus("agent-1", "conv-1", "teleport-1"),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(1000);
    const client = createMcpSubprocessBrokerClient(broker.env)!;
    await expect(
      client.get("/v1/environments", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      client.post("/v1/environments", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  } finally {
    timeout.mockRestore();
    finishUpstream({});
    broker.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}, 2000);
