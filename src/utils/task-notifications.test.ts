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
const STOPPED = (description: string) =>
  `Background task "${description}" stopped.`;

const base = {
  id: "sub_a",
  description: "deploy check",
  parentAgentId: "agent-1",
  parentConversationId: "conv-1",
};

test("stop-failure notifications surface once per failed attempt and respect the interrupt scope matcher", () => {
  const seen = new Set<string>();
  const rows = [
    {
      ...base,
      id: "sub_a",
      status: "running",
      stopFailed: true,
      stopOutcome: { attempt: 1, kind: "failed" as const },
    },
    {
      ...base,
      id: "sub_b",
      description: "other conversation",
      parentConversationId: "conv-2",
      status: "running",
      stopFailed: true,
      stopOutcome: { attempt: 1, kind: "failed" as const },
    },
    {
      ...base,
      id: "sub_c",
      description: "other agent",
      parentAgentId: "agent-2",
      status: "running",
      stopFailed: true,
      stopOutcome: { attempt: 1, kind: "failed" as const },
    },
    {
      ...base,
      id: "sub_d",
      description: "no recorded parent agent",
      parentAgentId: undefined,
      status: "running",
      stopFailed: true,
      stopOutcome: { attempt: 1, kind: "failed" as const },
    },
    {
      ...base,
      id: "sub_e",
      description: "already settled",
      status: "error",
      stopFailed: true,
      stopOutcome: { attempt: 1, kind: "failed" as const },
    },
    {
      ...base,
      id: "sub_f",
      description: "healthy task",
      status: "running",
    },
  ];

  const scope = { agentId: "agent-1", conversationId: "conv-1" };
  const first = selectStopFailedNotifications(rows, seen, scope);
  expect(first.failures).toEqual([FAILURE("deploy check")]);
  expect(first.stops).toEqual([]);

  // Deduplicated while the row stays a live stop-failure in scope.
  const second = selectStopFailedNotifications(rows, seen, scope);
  expect(second.failures).toEqual([]);

  // The scope matcher mirrors the interrupt paths exactly: agent matching
  // is exact, so a row with no recorded parent agent never notifies under
  // a specific agent scope (Esc could not retry it there either).
  const otherAgentSeen = new Set<string>();
  const otherAgent = selectStopFailedNotifications(rows, otherAgentSeen, {
    agentId: "agent-2",
    conversationId: "conv-1",
  });
  expect(otherAgent.failures).toEqual([FAILURE("other agent")]);
  expect(
    selectStopFailedNotifications(rows, new Set<string>(), {
      agentId: "agent-1",
      conversationId: "conv-1",
    }).failures,
  ).not.toContain(FAILURE("no recorded parent agent"));
  // But a scope without an agent id still reaches the unscoped row.
  expect(
    selectStopFailedNotifications(rows, new Set<string>(), {
      conversationId: "conv-1",
    }).failures,
  ).toContain(FAILURE("no recorded parent agent"));
});

test("a fast retry that fails re-notifies without any render observing the in-flight state", () => {
  const seen = new Set<string>();
  const scope = { agentId: "agent-1", conversationId: "conv-1" };

  // First failure surfaces (attempt 1).
  const first = selectStopFailedNotifications(
    [
      {
        ...base,
        status: "running",
        stopFailed: true,
        stopOutcome: { attempt: 1, kind: "failed" },
      },
    ],
    seen,
    scope,
  );
  expect(first.failures).toEqual([FAILURE("deploy check")]);

  // The retry dispatches and settles between two renders: the only
  // snapshot the effect ever sees is the restored failure for attempt 2.
  const refailed = selectStopFailedNotifications(
    [
      {
        ...base,
        status: "running",
        stopFailed: true,
        stopOutcome: { attempt: 2, kind: "failed" },
      },
    ],
    seen,
    scope,
  );
  expect(refailed.failures).toEqual([FAILURE("deploy check")]);
  expect(refailed.stops).toEqual([]);

  // Same attempt never re-notifies.
  const stable = selectStopFailedNotifications(
    [
      {
        ...base,
        status: "running",
        stopFailed: true,
        stopOutcome: { attempt: 2, kind: "failed" },
      },
    ],
    seen,
    scope,
  );
  expect(stable.failures).toEqual([]);
});

test("a fast retry that lands emits the correction from a single terminal snapshot", () => {
  const seen = new Set<string>();
  const scope = { agentId: "agent-1", conversationId: "conv-1" };

  selectStopFailedNotifications(
    [
      {
        ...base,
        status: "running",
        stopFailed: true,
        stopOutcome: { attempt: 1, kind: "failed" },
      },
    ],
    seen,
    scope,
  );
  // Dispatch and settlement both land before the next render: the only
  // snapshot is the terminal row with the recorded stopped outcome.
  const landed = selectStopFailedNotifications(
    [
      {
        ...base,
        status: "error",
        stopOutcome: { attempt: 2, kind: "stopped" },
      },
    ],
    seen,
    scope,
  );
  expect(landed.failures).toEqual([]);
  expect(landed.stops).toEqual([STOPPED("deploy check")]);

  // Terminal state is stable: no repeat messages on later snapshots.
  const settled = selectStopFailedNotifications(
    [
      {
        ...base,
        status: "error",
        stopOutcome: { attempt: 2, kind: "stopped" },
      },
    ],
    seen,
    scope,
  );
  expect(settled.failures).toEqual([]);
  expect(settled.stops).toEqual([]);
});

test("a first stop that lands is never reported as a correction", () => {
  const seen = new Set<string>();
  const scope = { agentId: "agent-1", conversationId: "conv-1" };
  // No failure was ever surfaced; a normal interrupt's successful stop
  // must not emit a "stopped." line.
  const result = selectStopFailedNotifications(
    [
      {
        ...base,
        status: "error",
        stopOutcome: { attempt: 1, kind: "stopped" },
      },
    ],
    seen,
    scope,
  );
  expect(result.failures).toEqual([]);
  expect(result.stops).toEqual([]);
});

test("a run that fails naturally during a retry is never reported as a stop", () => {
  const seen = new Set<string>();
  const scope = { agentId: "agent-1", conversationId: "conv-1" };

  selectStopFailedNotifications(
    [
      {
        ...base,
        status: "running",
        stopFailed: true,
        stopOutcome: { attempt: 1, kind: "failed" },
      },
    ],
    seen,
    scope,
  );
  // The task fails on its own while the retry's cancel is in flight: the
  // settle records the natural outcome, and the row's own failure
  // notification owns the transcript — no false "stopped." correction.
  const natural = selectStopFailedNotifications(
    [
      {
        ...base,
        status: "error",
        stopOutcome: { attempt: 2, kind: "natural" },
      },
    ],
    seen,
    scope,
  );
  expect(natural.failures).toEqual([]);
  expect(natural.stops).toEqual([]);

  // Natural completion is equally silent.
  const completed = selectStopFailedNotifications(
    [
      {
        ...base,
        status: "completed",
        stopOutcome: { attempt: 2, kind: "natural" },
      },
    ],
    seen,
    scope,
  );
  expect(completed.failures).toEqual([]);
  expect(completed.stops).toEqual([]);
});

test("scope switches never replay a failure and never drop a landed correction", () => {
  const seen = new Set<string>();
  const scopeA = { agentId: "agent-1", conversationId: "conv-1" };
  const scopeB = { agentId: "agent-1", conversationId: "conv-2" };
  const liveFailure = {
    ...base,
    status: "running",
    stopFailed: true,
    stopOutcome: { attempt: 1, kind: "failed" as const },
  };

  // Failure surfaces in conv-1.
  expect(
    selectStopFailedNotifications([liveFailure], seen, scopeA).failures,
  ).toEqual([FAILURE("deploy check")]);

  // Switch to conv-2 and back: the still-live failure must not replay.
  selectStopFailedNotifications([liveFailure], seen, scopeB);
  expect(
    selectStopFailedNotifications([liveFailure], seen, scopeA).failures,
  ).toEqual([]);

  // The retry lands while conv-2 is active: nothing is written there...
  const landedRow = {
    ...base,
    status: "error",
    stopOutcome: { attempt: 2, kind: "stopped" as const },
  };
  expect(
    selectStopFailedNotifications([landedRow], seen, scopeB).stops,
  ).toEqual([]);
  // ...and returning to conv-1 emits the retained correction.
  expect(
    selectStopFailedNotifications([landedRow], seen, scopeA).stops,
  ).toEqual([STOPPED("deploy check")]);
  // Exactly once.
  expect(
    selectStopFailedNotifications([landedRow], seen, scopeA).stops,
  ).toEqual([]);
});

test("entries retire only when their row leaves the snapshot", () => {
  const seen = new Set<string>();
  const scope = { agentId: "agent-1", conversationId: "conv-1" };
  const row = {
    ...base,
    status: "running",
    stopFailed: true,
    stopOutcome: { attempt: 1, kind: "failed" as const },
  };
  selectStopFailedNotifications([row], seen, scope);
  expect(seen.has("sub_a:1")).toBe(true);

  // Row still in the snapshot (even terminal): entry survives.
  selectStopFailedNotifications(
    [
      {
        ...base,
        status: "error",
        stopOutcome: { attempt: 2, kind: "stopped" },
      },
    ],
    seen,
    scope,
  );
  expect(seen.has("sub_a:1")).toBe(true);

  // Row deleted from the store: entry retires.
  selectStopFailedNotifications([], seen, scope);
  expect(seen.has("sub_a:1")).toBe(false);
});
