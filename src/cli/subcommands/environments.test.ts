import { expect, spyOn, test } from "bun:test";
import type {
  EnvironmentConnection,
  listEnvironments,
} from "@/backend/api/environments";
import { settingsManager } from "@/settings-manager";
import { runEnvironmentsSubcommand } from "./environments";

function environment(id: string, online = true): EnvironmentConnection {
  return {
    id,
    deviceId: "shared-device",
    connectionId: online ? `conn-${id}` : null,
    connectionName: "Computer",
    organizationId: "org-1",
    podId: null,
    connectedAt: null,
    lastHeartbeat: online ? Date.now() : null,
    lastSeenAt: Date.now(),
    firstSeenAt: Date.now(),
  };
}

async function runList(args: string[], list: typeof listEnvironments) {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const deviceId = spyOn(
    settingsManager,
    "getOrCreateDeviceId",
  ).mockReturnValue("test-current-device");
  try {
    expect(
      await runEnvironmentsSubcommand(["list", ...args], {
        initializeSettings: async () => {},
        listEnvironments: list,
      }),
    ).toBe(0);
    return JSON.parse(String(log.mock.calls[0]?.[0]));
  } finally {
    deviceId.mockRestore();
    log.mockRestore();
  }
}

test("--limit 1 advances by record id even when device ids are shared", async () => {
  const records = [environment("env-1"), environment("env-2")];
  const calls: unknown[] = [];
  const list: typeof listEnvironments = async (options) => {
    calls.push(options);
    // Model the server ignoring unknown cursors and returning page one.
    const index = records.findIndex((record) => record.id === options?.after);
    const start = index + 1;
    return {
      connections: records.slice(start, start + 1),
      hasNextPage: start + 1 < records.length,
    };
  };
  const first = await runList(["--limit", "1"], list);
  expect(first.connections[0]).toMatchObject({
    id: "env-1",
    deviceId: "shared-device",
    isOnline: true,
  });
  expect(first.nextCursor).toBe("env-1");
  const second = await runList(
    ["--limit", "1", "--after", first.connections[0].id],
    list,
  );
  expect(second.connections[0].id).toBe("env-2");
  expect(second.nextCursor).toBeNull();
  expect(second.hasNextPage).toBe(false);
  expect(calls).toEqual([
    { limit: 1, after: undefined, onlineOnly: false },
    { limit: 1, after: "env-1", onlineOnly: false },
  ]);
});

test("online-only keeps the raw page cursor when trailing records are filtered", async () => {
  const first = await runList(["--online-only", "--limit", "2"], async () => ({
    connections: [environment("env-1"), environment("env-2", false)],
    hasNextPage: true,
  }));
  expect(first.connections.map((record: { id: string }) => record.id)).toEqual([
    "env-1",
  ]);
  expect(first.nextCursor).toBe("env-2");
  expect(first.hasNextPage).toBe(true);
  const second = await runList(
    ["--online-only", "--limit", "1", "--after", first.nextCursor],
    async (options) => {
      expect(options).toEqual({ limit: 1, after: "env-2", onlineOnly: true });
      return { connections: [environment("env-3")], hasNextPage: false };
    },
  );
  expect(second.connections[0].id).toBe("env-3");
  expect(second.nextCursor).toBeNull();
});

test("online-only exposes a cursor for an empty filtered page", async () => {
  const page = await runList(["--online-only", "--limit", "1"], async () => ({
    connections: [environment("env-1", false)],
    hasNextPage: true,
  }));
  expect(page.connections).toEqual([]);
  expect(page.hasNextPage).toBe(true);
  expect(page.nextCursor).toBe("env-1");
});

test("help explains the record id and filtered-page cursor", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(await runEnvironmentsSubcommand(["--help"])).toBe(0);
    expect(log.mock.calls[0]?.[0]).toContain(
      "The id of the last record from the previous page",
    );
    expect(log.mock.calls[0]?.[0]).toContain("Pass nextCursor to --after");
  } finally {
    log.mockRestore();
  }
});
