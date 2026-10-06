import { describe, expect, test } from "bun:test";
import type {
  AgentRuntimeStatusEntry,
  AgentRuntimeStatusSnapshot,
} from "@/backend/api/agents";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import {
  acquireRecoveryClaim,
  canRecoverConversation,
} from "./recovery-ownership";
import { evictConversationRuntimeIfIdle } from "./runtime";
import {
  clearExpectedInboundTeleport,
  expectInboundTeleport,
} from "./teleport";

function runtime() {
  const value = getOrCreateScopedRuntime(createRuntime(), "agent-1", "conv-1");
  value.listener.connectionId = "conn-self";
  value.listener.connectionGeneration = "generation-self";
  return value;
}

function snapshot(
  status: Partial<AgentRuntimeStatusEntry>,
): AgentRuntimeStatusSnapshot {
  return {
    agent_id: "agent-1",
    snapshot_at: 0,
    statuses: [
      {
        conversation_id: "conv-1",
        state: "IDLE",
        loop_state: null,
        active_run_ids: [],
        last_activity_at: 0,
        ...status,
      },
    ],
  };
}

describe("recovery ownership", () => {
  test("inbound handoff prevents eviction only until cleared or expired", () => {
    const ordinary = runtime();
    expect(evictConversationRuntimeIfIdle(ordinary)).toBe(true);
    const incoming = runtime();
    expectInboundTeleport(incoming, "handoff");
    expect(evictConversationRuntimeIfIdle(incoming)).toBe(false);
    clearExpectedInboundTeleport(incoming);
    expect(evictConversationRuntimeIfIdle(incoming)).toBe(true);
    const expired = runtime();
    expectInboundTeleport(expired, "expired");
    expired.expectedTeleportExpiresAt = Date.now() - 1;
    expect(evictConversationRuntimeIfIdle(expired)).toBe(true);
  });
  test("a freshly prepared or restarted listener cannot recover another active owner", async () => {
    const value = runtime();
    expect(
      await canRecoverConversation(value, async () =>
        snapshot({
          state: "ACTIVE",
          active_harness: { connection_id: "conn-other" },
        }),
      ),
    ).toBe(false);
  });
  test("ownerless crash and same-listener recovery remain available", async () => {
    const value = runtime();
    expect(await canRecoverConversation(value, async () => snapshot({}))).toBe(
      true,
    );
    expect(
      await canRecoverConversation(value, async () =>
        snapshot({
          state: "ACTIVE",
          active_harness: { connection_id: "conn-self" },
        }),
      ),
    ).toBe(true);
  });
  test("conflicts, pending delivery and unclaimed live runs are not crashed ownerless work", async () => {
    for (const state of ["PENDING_DELIVERY", "ACTIVE_UNATTRIBUTED"] as const) {
      expect(
        await canRecoverConversation(runtime(), async () =>
          snapshot({ state }),
        ),
      ).toBe(false);
    }
    expect(
      await canRecoverConversation(runtime(), async () =>
        snapshot({ has_conflicting_listeners: true }),
      ),
    ).toBe(false);
  });
  test("cannot recover when ownership lookup fails", async () => {
    expect(
      await canRecoverConversation(runtime(), async () => {
        throw new Error("offline");
      }),
    ).toBe(false);
  });
  test("handoff or connection replacement during lookup prevents recovery", async () => {
    const value = runtime();
    expect(
      await canRecoverConversation(value, async () => {
        expectInboundTeleport(value, "incoming");
        return snapshot({});
      }),
    ).toBe(false);
    const replaced = runtime();
    expect(
      await canRecoverConversation(replaced, async () => {
        replaced.listener.connectionId = "conn-new";
        return snapshot({});
      }),
    ).toBe(false);
  });

  test("two processes cannot concurrently acquire the same recovery claim", async () => {
    let owner: { connectionId: string; token: string; fence: number } | null =
      null;
    let nextFence = 1;
    const request = async (_agentId: string, body: Record<string, unknown>) => {
      const action = body.action;
      const connectionId = body.connection_id as string;
      if (action === "acquire") {
        if (owner) throw new Error("already claimed");
        owner = {
          connectionId,
          token: `token-${connectionId}`,
          fence: nextFence++,
        };
        return { token: owner.token, fence: owner.fence, expires_at: 30_000 };
      }
      if (
        action === "release" &&
        owner?.connectionId === connectionId &&
        owner.token === body.token
      ) {
        owner = null;
      }
      return { released: owner === null };
    };
    const first = runtime();
    const second = runtime();
    second.listener.connectionId = "conn-second";
    second.listener.connectionGeneration = "generation-second";
    const dependencies = {
      request: request as never,
      schedule: () => 1,
      cancel: () => {},
    };

    const firstClaim = await acquireRecoveryClaim(
      first,
      () => {},
      dependencies,
    );
    expect(firstClaim?.owned).toBe(true);
    expect(
      await acquireRecoveryClaim(second, () => {}, dependencies),
    ).toBeNull();
    await firstClaim?.release();
    expect(
      (await acquireRecoveryClaim(second, () => {}, dependencies))?.owned,
    ).toBe(true);
  });

  test("renewal loss fences the old process before its next side effect", async () => {
    const scheduled: Array<() => void> = [];
    let lost = false;
    let renews = 0;
    const value = runtime();
    const claim = await acquireRecoveryClaim(
      value,
      () => {
        lost = true;
      },
      {
        request: (async (_agentId: string, body: { action: string }) => {
          if (body.action === "acquire") {
            return { token: "token-1", fence: 7, expires_at: 30_000 };
          }
          renews += 1;
          return { token: "token-2", fence: 8, expires_at: 30_000 };
        }) as never,
        schedule: (callback) => {
          scheduled.push(callback);
          return callback;
        },
        cancel: () => {},
      },
    );
    expect(claim?.owned).toBe(true);
    scheduled.shift()?.();
    for (let attempt = 0; attempt < 20 && !lost; attempt += 1) {
      await Promise.resolve();
    }
    expect(renews).toBe(1);
    expect(lost).toBe(true);
    expect(claim?.owned).toBe(false);
  });

  test("local expiry fences a paused process before a delayed renewal", async () => {
    let now = 1_000;
    let lost = false;
    const value = runtime();
    const claim = await acquireRecoveryClaim(
      value,
      () => {
        lost = true;
      },
      {
        request: (async () => ({
          token: "token-1",
          fence: 7,
          expires_at: 16_000,
        })) as never,
        schedule: () => 1,
        cancel: () => {},
        now: () => now,
      },
    );
    expect(claim?.owned).toBe(true);
    now = 15_500;
    expect(claim?.owned).toBe(false);
    expect(await claim?.renew()).toBe(false);
    expect(lost).toBe(true);
  });
});
