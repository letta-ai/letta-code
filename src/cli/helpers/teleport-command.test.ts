import { describe, expect, test } from "bun:test";
import type { EnvironmentConnection } from "@/backend/api/environments";
import { buildTeleportMessage } from "./teleport-command";

function environment(
  deviceId: string,
  overrides: Partial<EnvironmentConnection> = {},
): EnvironmentConnection {
  return {
    id: deviceId,
    deviceId,
    connectionId: `connection-${deviceId}`,
    connectionName: deviceId,
    organizationId: "org",
    podId: null,
    connectedAt: Date.now(),
    lastHeartbeat: Date.now(),
    lastSeenAt: Date.now(),
    firstSeenAt: Date.now(),
    ...overrides,
  };
}

describe("teleport reminder", () => {
  test("uses the managed Cloud runtime marker with an opaque device ID", async () => {
    const previous = process.env.LETTA_MANAGED_CLOUD_RUNTIME;
    process.env.LETTA_MANAGED_CLOUD_RUNTIME = "1";
    try {
      const message = await buildTeleportMessage(undefined, async () => ({
        hasNextPage: false,
        connections: [environment("uuid-laptop")],
      }));
      expect(message).toContain("uuid-laptop");
      expect(message).not.toContain("letta teleport cloud");
    } finally {
      if (previous === undefined)
        delete process.env.LETTA_MANAGED_CLOUD_RUNTIME;
      else process.env.LETTA_MANAGED_CLOUD_RUNTIME = previous;
    }
  });

  test("local execution sends Cloud handoff without listing computers", async () => {
    const message = await buildTeleportMessage(false, async () => {
      throw new Error("should not list");
    });
    expect(message).toContain("<system-reminder>");
    expect(message).toContain("letta teleport cloud");
  });

  test("Cloud execution lists only fresh remote computers", async () => {
    const calls: unknown[] = [];
    const message = await buildTeleportMessage(true, async (options) => {
      calls.push(options);
      return {
        hasNextPage: false,
        connections: [
          environment("laptop"),
          environment("sandbox-agent-1"),
          environment("__letta_cloud__"),
          environment("offline", { lastHeartbeat: Date.now() - 200_000 }),
          environment("desktop-local", { organizationId: "local" }),
          environment("local-connection", { connectionId: "local-123" }),
        ],
      };
    });
    expect(calls).toEqual([{ limit: 100, onlineOnly: true, after: undefined }]);
    expect(message).toContain("laptop");
    expect(message).toContain("Ask which location");
    expect(message).not.toContain("sandbox-agent-1");
    expect(message).not.toContain("__letta_cloud__");
    expect(message).not.toContain("offline");
    expect(message).not.toContain("desktop-local");
    expect(message).not.toContain("local-connection");
  });

  test("collects online computers across pages", async () => {
    const cursors: Array<string | undefined> = [];
    const message = await buildTeleportMessage(true, async (options) => {
      cursors.push(options?.after);
      return options?.after
        ? { hasNextPage: false, connections: [environment("second")] }
        : { hasNextPage: true, connections: [environment("first")] };
    });
    expect(cursors).toEqual([undefined, "first"]);
    expect(message).toContain("first");
    expect(message).toContain("second");
  });

  test("no destinations does not ask for an unavailable choice", async () => {
    const message = await buildTeleportMessage(true, async () => ({
      hasNextPage: false,
      connections: [],
    }));
    expect(message).toContain("No other locations are online");
    expect(message).not.toContain("Ask which location");
  });
});
