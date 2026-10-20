import { expect, test } from "bun:test";
import { runWithRuntimeContext, updateRuntimeContext } from "@/runtime-context";
import { resolveNotificationScope } from "./task-notifications";

for (const actingUserId of ["user-a", undefined]) {
  test(`notification scope retains ${actingUserId ?? "anonymous"} ownership after the turn changes`, () => {
    runWithRuntimeContext({ actingUserId }, () => {
      const scope = resolveNotificationScope({
        agentId: "agent-a",
        conversationId: "conv-a",
      });
      updateRuntimeContext({
        actingUserId: "user-b",
        agentId: "agent-b",
        conversationId: "conv-b",
      });
      expect(scope).toEqual({
        agentId: "agent-a",
        conversationId: "conv-a",
        actingUserId,
      });
    });
  });
}

test("notification scope preserves explicit ambient-actor suppression", () => {
  runWithRuntimeContext(
    {
      actingUserId: "ambient-user",
      suppressActingUserFallback: true,
    },
    () => {
      expect(
        resolveNotificationScope({
          agentId: "agent-a",
          conversationId: "conv-a",
        }),
      ).toEqual({
        agentId: "agent-a",
        conversationId: "conv-a",
        actingUserId: null,
      });
    },
  );
});

import { selectStopFailedNotifications } from "./task-notifications";

const FAILURE = (description: string) =>
  `Background task "${description}" could not be stopped — still running remotely. Press Esc to retry.`;

test("stop-failed notifications surface once per live row and respect agent and conversation scope", () => {
  const seen = new Set<string>();
  const retrying = new Set<string>();
  const rows = [
    {
      id: "sub_a",
      description: "deploy check",
      status: "running",
      stopFailed: true,
      parentAgentId: "agent-1",
      parentConversationId: "conv-1",
    },
    {
      id: "sub_b",
      description: "other conversation",
      status: "running",
      stopFailed: true,
      parentAgentId: "agent-1",
      parentConversationId: "conv-2",
    },
    {
      id: "sub_c",
      description: "other agent",
      status: "running",
      stopFailed: true,
      parentAgentId: "agent-2",
      parentConversationId: "conv-1",
    },
    {
      id: "sub_d",
      description: "already settled",
      status: "error",
      stopFailed: true,
      parentAgentId: "agent-1",
      parentConversationId: "conv-1",
    },
    {
      id: "sub_e",
      description: "healthy task",
      status: "running",
      parentAgentId: "agent-1",
      parentConversationId: "conv-1",
    },
  ];

  const scope = { agentId: "agent-1", conversationId: "conv-1" };
  const first = selectStopFailedNotifications(rows, seen, retrying, scope);
  expect(first.failures).toEqual([FAILURE("deploy check")]);
  expect(first.stops).toEqual([]);

  // Deduplicated while the row stays a live stop-failure in scope.
  const second = selectStopFailedNotifications(rows, seen, retrying, scope);
  expect(second.failures).toEqual([]);

  // Switching agents must not surface — or consume — another agent's
  // failure: agent-2's row stays unseen for agent-1's transcript, and
  // agent-2's view would surface it fresh.
  const otherAgentSeen = new Set<string>();
  const otherAgent = selectStopFailedNotifications(
    rows,
    otherAgentSeen,
    new Set<string>(),
    { agentId: "agent-2", conversationId: "conv-1" },
  );
  expect(otherAgent.failures).toEqual([FAILURE("other agent")]);

  // A row with no recorded parent (legacy) still notifies in any scope.
  const legacy = selectStopFailedNotifications(
    [
      {
        id: "sub_f",
        description: "legacy row",
        status: "running",
        stopFailed: true,
      },
    ],
    new Set<string>(),
    new Set<string>(),
    scope,
  );
  expect(legacy.failures).toEqual([FAILURE("legacy row")]);
});

test("a failed retry re-notifies and a landed retry reports the stop", () => {
  const seen = new Set<string>();
  const retrying = new Set<string>();
  const scope = { agentId: "agent-1", conversationId: "conv-1" };
  const base = {
    id: "sub_a",
    description: "deploy check",
    parentAgentId: "agent-1",
    parentConversationId: "conv-1",
  };

  // First failure surfaces.
  const first = selectStopFailedNotifications(
    [{ ...base, status: "running", stopFailed: true }],
    seen,
    retrying,
    scope,
  );
  expect(first.failures).toEqual([FAILURE("deploy check")]);

  // The user dispatches the retry: the row leaves the surfaced state and
  // the id moves to the retrying set — the dedupe entry is released.
  const dispatched = selectStopFailedNotifications(
    [{ ...base, status: "error", cancelPending: true }],
    seen,
    retrying,
    scope,
  );
  expect(dispatched.failures).toEqual([]);
  expect(dispatched.stops).toEqual([]);
  expect(seen.has("sub_a")).toBe(false);
  expect(retrying.has("sub_a")).toBe(true);

  // The retry fails too: the restore re-enters the surfaced state and the
  // failure re-notifies (the first notification is not the last word).
  const refailed = selectStopFailedNotifications(
    [{ ...base, status: "running", stopFailed: true }],
    seen,
    retrying,
    scope,
  );
  expect(refailed.failures).toEqual([FAILURE("deploy check")]);
  expect(refailed.stops).toEqual([]);
  expect(retrying.has("sub_a")).toBe(false);

  // Dispatch again, then the stop lands: the correction reports it.
  selectStopFailedNotifications(
    [{ ...base, status: "error", cancelPending: true }],
    seen,
    retrying,
    scope,
  );
  const landed = selectStopFailedNotifications(
    [{ ...base, status: "error" }],
    seen,
    retrying,
    scope,
  );
  expect(landed.failures).toEqual([]);
  expect(landed.stops).toEqual(['Background task "deploy check" stopped.']);
  expect(retrying.has("sub_a")).toBe(false);

  // Terminal state is stable: no repeat messages on later snapshots.
  const settled = selectStopFailedNotifications(
    [{ ...base, status: "error" }],
    seen,
    retrying,
    scope,
  );
  expect(settled.failures).toEqual([]);
  expect(settled.stops).toEqual([]);
});

test("a run that settles naturally during a retry stays silent", () => {
  const seen = new Set<string>();
  const retrying = new Set<string>();
  const scope = { agentId: "agent-1", conversationId: "conv-1" };
  const base = {
    id: "sub_a",
    description: "deploy check",
    parentAgentId: "agent-1",
    parentConversationId: "conv-1",
  };

  selectStopFailedNotifications(
    [{ ...base, status: "running", stopFailed: true }],
    seen,
    retrying,
    scope,
  );
  selectStopFailedNotifications(
    [{ ...base, status: "error", cancelPending: true }],
    seen,
    retrying,
    scope,
  );
  // Natural completion while the retry was in flight: the completion path
  // owns that message; the retry tracker just retires.
  const natural = selectStopFailedNotifications(
    [{ ...base, status: "completed" }],
    seen,
    retrying,
    scope,
  );
  expect(natural.failures).toEqual([]);
  expect(natural.stops).toEqual([]);
  expect(retrying.has("sub_a")).toBe(false);
});

test("a retry that lands while another conversation is active never writes there", () => {
  const seen = new Set<string>();
  const retrying = new Set<string>();
  const row = {
    id: "sub_a",
    description: "deploy check",
    status: "error",
    parentAgentId: "agent-1",
    parentConversationId: "conv-1",
  };
  // The failure was surfaced in conv-1 and its retry was dispatched there.
  selectStopFailedNotifications(
    [{ ...row, status: "running", stopFailed: true }],
    seen,
    retrying,
    { agentId: "agent-1", conversationId: "conv-1" },
  );
  selectStopFailedNotifications(
    [{ ...row, status: "error", cancelPending: true }],
    seen,
    retrying,
    { agentId: "agent-1", conversationId: "conv-1" },
  );
  // The stop lands while the user is in conv-2: no correction there, and
  // the tracker retires so conv-1 does not get a stale message on return.
  const elsewhere = selectStopFailedNotifications([row], seen, retrying, {
    agentId: "agent-1",
    conversationId: "conv-2",
  });
  expect(elsewhere.failures).toEqual([]);
  expect(elsewhere.stops).toEqual([]);
  expect(retrying.has("sub_a")).toBe(false);
});
