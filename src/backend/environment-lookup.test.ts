import { describe, expect, test } from "bun:test";
import type {
  EnvironmentConnection,
  listEnvironments,
} from "@/backend/api/environments";
import { ApiRequestError } from "@/backend/api/request";
import {
  resolveDesktopEnvironmentConnectionId,
  resolveEnvironmentConnectionId,
} from "@/backend/environment-lookup";

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

const notFound = new ApiRequestError("not found", 404, "not found");

function missingPointLookup(): Promise<EnvironmentConnection> {
  return Promise.reject(notFound);
}

describe("Computer environment resolution", () => {
  test("resolves a known device through the point endpoint without listing", async () => {
    const selected = environment();
    let listCalls = 0;

    expect(
      await resolveEnvironmentConnectionId("device-1", {
        get: async () => selected,
        list: async () => {
          listCalls += 1;
          throw new Error("must not list a known device");
        },
      }),
    ).toEqual({ connectionId: "conn-1", environment: selected });
    expect(listCalls).toBe(0);
  });

  test("propagates non-404 point lookup failures without listing", async () => {
    const failure = new ApiRequestError("unavailable", 503, "unavailable");
    let listCalls = 0;

    await expect(
      resolveEnvironmentConnectionId("device-1", {
        get: async () => {
          throw failure;
        },
        list: async () => {
          listCalls += 1;
          return { connections: [], hasNextPage: false };
        },
      }),
    ).rejects.toBe(failure);
    expect(listCalls).toBe(0);
  });

  test("falls back to the device's online rows when the point row is stale", async () => {
    const stale = environment({
      connectionId: null,
      lastHeartbeat: null,
    });
    const online = environment({
      connectionId: "conn-online",
    });
    const calls: Parameters<typeof listEnvironments>[0][] = [];

    await expect(
      resolveEnvironmentConnectionId("device-1", {
        get: async () => stale,
        list: async (options = {}) => {
          calls.push(options);
          return { connections: [online], hasNextPage: false };
        },
      }),
    ).resolves.toEqual({ connectionId: "conn-online", environment: online });
    expect(calls).toEqual([
      { limit: 100, onlineOnly: true, deviceId: "device-1" },
    ]);
  });

  test("retries stale point recovery without device filtering on older servers", async () => {
    const stale = environment({
      connectionId: null,
      lastHeartbeat: null,
    });
    const online = environment({ connectionId: "conn-online" });
    const calls: Parameters<typeof listEnvironments>[0][] = [];

    await expect(
      resolveEnvironmentConnectionId("device-1", {
        get: async () => stale,
        list: async (options = {}) => {
          calls.push(options);
          if (options.deviceId) {
            throw new ApiRequestError("unsupported", 422, "unsupported");
          }
          return { connections: [online], hasNextPage: false };
        },
      }),
    ).resolves.toEqual({ connectionId: "conn-online", environment: online });
    expect(calls).toEqual([
      { limit: 100, onlineOnly: true, deviceId: "device-1" },
      { limit: 100, onlineOnly: true },
    ]);
  });

  test("resolves an exact name after one complete bounded page", async () => {
    const selected = environment({ connectionName: "Work Mac" });
    const calls: Parameters<typeof listEnvironments>[0][] = [];

    const result = await resolveEnvironmentConnectionId(" Work Mac ", {
      get: missingPointLookup,
      list: async (options = {}) => {
        calls.push(options);
        return { connections: [selected], hasNextPage: false };
      },
    });

    expect(result).toEqual({ connectionId: "conn-1", environment: selected });
    expect(calls).toEqual([{ limit: 100 }]);
  });

  test("prefers an explicit connection ID over another device's exact name", async () => {
    const explicit = environment({
      id: "env-explicit",
      connectionId: "selector",
      deviceId: "device-explicit",
      connectionName: "Explicit",
    });
    const named = environment({
      id: "env-named",
      connectionId: "conn-named",
      deviceId: "device-named",
      connectionName: "selector",
    });

    await expect(
      resolveEnvironmentConnectionId("selector", {
        get: missingPointLookup,
        list: async (options = {}) =>
          options.connectionName
            ? { connections: [named], hasNextPage: false }
            : { connections: [named, explicit], hasNextPage: false },
      }),
    ).resolves.toEqual({ connectionId: "selector", environment: explicit });
  });

  test("prefers an explicit environment ID over another device's exact name", async () => {
    const explicit = environment({
      id: "selector",
      connectionId: "conn-explicit",
      deviceId: "device-explicit",
      connectionName: "Explicit",
    });
    const named = environment({
      id: "env-named",
      connectionId: "conn-named",
      deviceId: "device-named",
      connectionName: "selector",
    });

    await expect(
      resolveEnvironmentConnectionId("selector", {
        get: missingPointLookup,
        list: async (options = {}) =>
          options.connectionName
            ? { connections: [named], hasNextPage: false }
            : { connections: [named, explicit], hasNextPage: false },
      }),
    ).resolves.toEqual({
      connectionId: "conn-explicit",
      environment: explicit,
    });
  });

  test("rejects one exact name shared by local and remote devices", async () => {
    const remote = environment({ connectionName: "Desktop" });
    const local = environment({
      id: "env-local",
      connectionId: "local-connection",
      deviceId: "device-local",
      connectionName: "Desktop",
      organizationId: "local",
    });

    await expect(
      resolveEnvironmentConnectionId("Desktop", {
        get: missingPointLookup,
        list: async (options = {}) =>
          options.connectionName
            ? { connections: [remote], hasNextPage: false }
            : { connections: [remote, local], hasNextPage: false },
      }),
    ).rejects.toThrow('Computer "Desktop" is ambiguous');
  });

  test("finds an explicit listener ID on a later complete page", async () => {
    const decoy = environment({
      id: "env-decoy",
      connectionId: "conn-decoy",
      connectionName: "Other",
    });
    const selected = environment();
    const calls: Parameters<typeof listEnvironments>[0][] = [];

    await expect(
      resolveEnvironmentConnectionId("env-1", {
        get: missingPointLookup,
        list: async (options = {}) => {
          calls.push(options);
          return options.after
            ? { connections: [selected], hasNextPage: false }
            : { connections: [decoy], hasNextPage: true };
        },
      }),
    ).resolves.toEqual({ connectionId: "conn-1", environment: selected });
    expect(calls).toEqual([{ limit: 100 }, { limit: 100, after: "env-decoy" }]);
  });

  test("selects the freshest online listener for one device name", async () => {
    const now = Date.now();
    const heartbeat = environment({
      connectionName: "Work Mac",
      lastHeartbeat: now - 1_000,
      lastSeenAt: now - 10_000,
    });
    const seen = environment({
      id: "env-2",
      connectionId: "conn-2",
      connectionName: "Work Mac",
      lastHeartbeat: now - 5_000,
      lastSeenAt: now,
    });

    expect(
      await resolveEnvironmentConnectionId("Work Mac", {
        get: missingPointLookup,
        list: async () => ({
          connections: [heartbeat, seen],
          hasNextPage: false,
        }),
      }),
    ).toEqual({ connectionId: "conn-2", environment: seen });
  });

  test("rejects a shared name across distinct online devices", async () => {
    await expect(
      resolveEnvironmentConnectionId("Environment", {
        get: missingPointLookup,
        list: async () => ({
          connections: [
            environment(),
            environment({
              id: "env-2",
              connectionId: "conn-2",
              deviceId: "device-2",
            }),
          ],
          hasNextPage: false,
        }),
      }),
    ).rejects.toThrow('Computer "Environment" is ambiguous');
  });

  test("preserves offline, missing, and empty selector errors", async () => {
    const offline = environment({
      connectionId: null,
      lastHeartbeat: null,
    });
    await expect(
      resolveEnvironmentConnectionId("device-1", {
        get: async () => offline,
        list: async () => ({ connections: [], hasNextPage: false }),
      }),
    ).rejects.toThrow("is offline");
    await expect(
      resolveEnvironmentConnectionId("missing", {
        get: missingPointLookup,
        list: async () => ({ connections: [], hasNextPage: false }),
      }),
    ).rejects.toThrow("not found");
    await expect(
      resolveEnvironmentConnectionId("  ", {
        get: async () => {
          throw new Error("must not get for an empty selector");
        },
        list: async () => {
          throw new Error("must not list for an empty selector");
        },
      }),
    ).rejects.toThrow("Computer selector must not be empty");
  });
  test("preserves local rows when the remote name selector returns no match", async () => {
    const local = environment({
      connectionId: "local-connection",
      connectionName: "Desktop",
      organizationId: "local",
    });

    await expect(
      resolveEnvironmentConnectionId("Desktop", {
        get: missingPointLookup,
        list: async (options = {}) =>
          options.connectionName
            ? { connections: [], hasNextPage: false }
            : { connections: [local], hasNextPage: false },
      }),
    ).resolves.toEqual({
      connectionId: "local-connection",
      environment: local,
    });
  });
});

describe("Desktop environment resolution", () => {
  test("uses one bounded remote-source request for one Desktop", async () => {
    const selected = environment({
      deviceId: "desktop:installation:user-1",
      connectionId: "conn-desktop",
      listenerInstanceId: "desktop-primary:installation",
    });
    const calls: Parameters<typeof listEnvironments>[0][] = [];

    await expect(
      resolveDesktopEnvironmentConnectionId({
        list: async (options = {}) => {
          calls.push(options);
          return { connections: [selected], hasNextPage: false };
        },
      }),
    ).resolves.toEqual({
      connectionId: "conn-desktop",
      environment: selected,
    });
    expect(calls).toEqual([{ limit: 100, onlineOnly: true, source: "remote" }]);
  });
  test("falls back when an older server rejects the source selector", async () => {
    const selected = environment({
      deviceId: "desktop:installation:user-1",
      connectionId: "conn-desktop",
      listenerInstanceId: "desktop-primary:installation",
    });
    const calls: Parameters<typeof listEnvironments>[0][] = [];

    await expect(
      resolveDesktopEnvironmentConnectionId({
        list: async (options = {}) => {
          calls.push(options);
          if (options.source) {
            throw new ApiRequestError("bad query", 400, "bad query");
          }
          return { connections: [selected], hasNextPage: false };
        },
      }),
    ).resolves.toEqual({
      connectionId: "conn-desktop",
      environment: selected,
    });
    expect(calls).toEqual([
      { limit: 100, onlineOnly: true, source: "remote" },
      { limit: 100, onlineOnly: true },
    ]);
  });

  test("falls back through all pages when a server ignores source", async () => {
    const local = environment({
      id: "env-local",
      connectionId: "local-connection",
      deviceId: "device-local",
      organizationId: "local",
    });
    const selected = environment({
      id: "env-desktop",
      deviceId: "desktop:installation:user-1",
      connectionId: "conn-desktop",
      listenerInstanceId: "desktop-primary:installation",
    });
    const calls: Parameters<typeof listEnvironments>[0][] = [];

    await expect(
      resolveDesktopEnvironmentConnectionId({
        list: async (options = {}) => {
          calls.push(options);
          if (options.source) {
            return { connections: [local], hasNextPage: true };
          }
          return options.after
            ? { connections: [selected], hasNextPage: false }
            : { connections: [local], hasNextPage: true };
        },
      }),
    ).resolves.toEqual({
      connectionId: "conn-desktop",
      environment: selected,
    });
    expect(calls).toEqual([
      { limit: 100, onlineOnly: true, source: "remote" },
      { limit: 100, onlineOnly: true },
      { limit: 100, after: "env-local", onlineOnly: true },
    ]);
  });

  test("paginates the full remote collection before checking ambiguity", async () => {
    const first = environment({
      id: "env-desktop-1",
      deviceId: "desktop:installation:user-1",
      connectionId: "conn-desktop-1",
      listenerInstanceId: "desktop-primary:installation-1",
    });
    const second = environment({
      id: "env-desktop-2",
      deviceId: "desktop:installation:user-2",
      connectionId: "conn-desktop-2",
      listenerInstanceId: "desktop-primary:installation-2",
    });

    await expect(
      resolveDesktopEnvironmentConnectionId({
        list: async (options = {}) => {
          if (options.source === "remote") {
            return { connections: [first], hasNextPage: true };
          }
          return options.after
            ? { connections: [second], hasNextPage: false }
            : { connections: [first], hasNextPage: true };
        },
      }),
    ).rejects.toThrow("Multiple Desktop computers are online");
  });
});
