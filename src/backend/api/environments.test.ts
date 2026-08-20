import { describe, expect, test } from "bun:test";
import type {
  EnvironmentConnection,
  listEnvironments,
} from "@/backend/api/environments";
import {
  createAgentSandbox,
  resolveDesktopEnvironmentConnectionId,
  teleportToEnvironment,
} from "@/backend/api/environments";
import type { apiRequest } from "@/backend/api/request";

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

  test("requires Desktop Remote Access to be online", async () => {
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
      "enable Remote Access",
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
      "Multiple Desktop environments are online",
    );
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
