import { describe, expect, test } from "bun:test";
import type { EnvironmentConnection } from "@/backend/api/environments";
import {
  buildTeleportMessage,
  isCloudTeleportExecution,
} from "./teleport-command";

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
  test("identifies managed Cloud execution even with an opaque device ID", () => {
    expect(
      isCloudTeleportExecution({ DAYTONA_SANDBOX_ID: "sb-1" }, "uuid-1"),
    ).toBe(true);
    expect(isCloudTeleportExecution({}, "sandbox-agent-1")).toBe(true);
    expect(isCloudTeleportExecution({}, "uuid-1")).toBe(false);
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
