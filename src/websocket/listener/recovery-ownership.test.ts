import { describe, expect, test } from "bun:test";
import type {
  AgentRuntimeStatusEntry,
  AgentRuntimeStatusSnapshot,
} from "@/backend/api/agents";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { canRecoverConversation } from "./recovery-ownership";
import { evictConversationRuntimeIfIdle } from "./runtime";
import {
  clearExpectedInboundTeleport,
  expectInboundTeleport,
} from "./teleport";

function runtime() {
  const value = getOrCreateScopedRuntime(createRuntime(), "agent-1", "conv-1");
  value.listener.connectionId = "conn-self";
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
});
