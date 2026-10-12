import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __resetOrganizationIdForTests,
  peekOrganizationId,
  setExplicitOrganizationId,
  warmOrganizationId,
} from "@/agent/organization-id";
import type { getBalanceMetadata } from "@/backend/api/metadata";

function fakeBalance(impl: () => Promise<{ organization_id?: string }>): {
  getBalance: typeof getBalanceMetadata;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const getBalance = (async (options: Record<string, unknown> = {}) => {
    calls.push(options);
    const result = await impl();
    return {
      total_balance: 0,
      monthly_credit_balance: 0,
      purchased_credit_balance: 0,
      billing_tier: "free",
      ...result,
    };
  }) as typeof getBalanceMetadata;
  return { getBalance, calls };
}

describe("organization id resolution", () => {
  beforeEach(() => __resetOrganizationIdForTests());
  afterEach(() => __resetOrganizationIdForTests());

  test("explicit organization wins without a network call", async () => {
    setExplicitOrganizationId("org-explicit");
    const { getBalance, calls } = fakeBalance(async () => ({
      organization_id: "org-other",
    }));

    expect(await warmOrganizationId({ getBalance })).toBe("org-explicit");
    expect(peekOrganizationId()).toBe("org-explicit");
    expect(calls).toHaveLength(0);
  });

  test("resolves from balance metadata once and caches it", async () => {
    const { getBalance, calls } = fakeBalance(async () => ({
      organization_id: "org-123",
    }));

    const [a, b] = await Promise.all([
      warmOrganizationId({ getBalance }),
      warmOrganizationId({ getBalance }),
    ]);
    expect(a).toBe("org-123");
    expect(b).toBe("org-123");
    expect(await warmOrganizationId({ getBalance })).toBe("org-123");
    expect(peekOrganizationId()).toBe("org-123");
    expect(calls).toHaveLength(1);
  });

  test("ignores an older server without organization_id", async () => {
    const { getBalance } = fakeBalance(async () => ({}));

    expect(await warmOrganizationId({ getBalance })).toBeUndefined();
    expect(peekOrganizationId()).toBeUndefined();
  });

  test("failure leaves it unset and does not retry within the cooldown", async () => {
    let clock = 1_000;
    const now = () => clock;
    const { getBalance, calls } = fakeBalance(async () => {
      throw new Error("boom");
    });

    expect(await warmOrganizationId({ getBalance, now })).toBeUndefined();
    expect(peekOrganizationId()).toBeUndefined();
    expect(await warmOrganizationId({ getBalance, now })).toBeUndefined();
    expect(calls).toHaveLength(1);

    clock += 10 * 60_000;
    await warmOrganizationId({ getBalance, now });
    expect(calls).toHaveLength(2);
  });

  test("times out instead of hanging", async () => {
    const getBalance = ((options: { signal?: AbortSignal } = {}) =>
      new Promise((_, reject) => {
        options.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      })) as typeof getBalanceMetadata;

    expect(
      await warmOrganizationId({ getBalance, timeoutMs: 10 }),
    ).toBeUndefined();
    expect(peekOrganizationId()).toBeUndefined();
  });
});
