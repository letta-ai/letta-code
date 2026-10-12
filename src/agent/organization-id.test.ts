import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __resetOrganizationIdForTests,
  peekOrganizationId,
  setExplicitOrganizationId,
  warmOrganizationId,
} from "@/agent/organization-id";
import type {
  EnvironmentConnection,
  listEnvironments,
} from "@/backend/api/environments";

function entry(organizationId: string): EnvironmentConnection {
  return {
    id: "env-1",
    connectionId: null,
    deviceId: "device-1",
    connectionName: "laptop",
    organizationId,
    podId: null,
    connectedAt: null,
    lastHeartbeat: null,
    lastSeenAt: 0,
    firstSeenAt: 0,
  };
}

function fakeList(
  impl: () => Promise<{ connections: EnvironmentConnection[] }>,
): { list: typeof listEnvironments; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const list = (async (options: Record<string, unknown> = {}) => {
    calls.push(options);
    const result = await impl();
    return { ...result, hasNextPage: false };
  }) as typeof listEnvironments;
  return { list, calls };
}

describe("organization id resolution", () => {
  beforeEach(() => __resetOrganizationIdForTests());
  afterEach(() => __resetOrganizationIdForTests());

  test("explicit organization wins without a network call", async () => {
    setExplicitOrganizationId("org-explicit");
    const { list, calls } = fakeList(async () => ({
      connections: [entry("org-other")],
    }));

    expect(await warmOrganizationId({ list })).toBe("org-explicit");
    expect(peekOrganizationId()).toBe("org-explicit");
    expect(calls).toHaveLength(0);
  });

  test("resolves from listEnvironments once and caches it", async () => {
    const { list, calls } = fakeList(async () => ({
      connections: [entry("org-123")],
    }));

    const [a, b] = await Promise.all([
      warmOrganizationId({ list }),
      warmOrganizationId({ list }),
    ]);
    expect(a).toBe("org-123");
    expect(b).toBe("org-123");
    expect(await warmOrganizationId({ list })).toBe("org-123");
    expect(peekOrganizationId()).toBe("org-123");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.limit).toBe(1);
  });

  test("ignores the local placeholder organization", async () => {
    const { list } = fakeList(async () => ({
      connections: [entry("local"), entry("org-real")],
    }));

    expect(await warmOrganizationId({ list })).toBe("org-real");
  });

  test("failure leaves it unset and does not retry within the cooldown", async () => {
    let clock = 1_000;
    const now = () => clock;
    const { list, calls } = fakeList(async () => {
      throw new Error("boom");
    });

    expect(await warmOrganizationId({ list, now })).toBeUndefined();
    expect(peekOrganizationId()).toBeUndefined();
    expect(await warmOrganizationId({ list, now })).toBeUndefined();
    expect(calls).toHaveLength(1);

    clock += 10 * 60_000;
    await warmOrganizationId({ list, now });
    expect(calls).toHaveLength(2);
  });

  test("times out instead of hanging", async () => {
    const list = ((options: { signal?: AbortSignal } = {}) =>
      new Promise((_, reject) => {
        options.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      })) as typeof listEnvironments;

    expect(await warmOrganizationId({ list, timeoutMs: 10 })).toBeUndefined();
    expect(peekOrganizationId()).toBeUndefined();
  });
});
