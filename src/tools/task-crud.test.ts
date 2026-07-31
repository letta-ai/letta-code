import { beforeEach, describe, expect, test } from "bun:test";
import {
  getRuntimeContext,
  type RuntimeContextSnapshot,
  runOutsideRuntimeContext,
  runWithRuntimeContext,
} from "@/runtime-context";
import { task_create as taskCreateImpl } from "@/tools/impl/task-create";
import { task_get as taskGetImpl } from "@/tools/impl/task-get";
import { task_list as taskListImpl } from "@/tools/impl/task-list";
import { task_update as taskUpdateImpl } from "@/tools/impl/task-update";
import {
  _resetTaskStoreForTests,
  clearTaskStoreScope,
} from "@/tools/impl/tasks/store";

const DEFAULT_SCOPE = {
  agentId: "agent-default",
  conversationId: "conversation-default",
} satisfies RuntimeContextSnapshot;

function inTaskScope<T>(
  fn: () => T,
  scope: RuntimeContextSnapshot = DEFAULT_SCOPE,
): T {
  return runWithRuntimeContext(scope, fn);
}

function withDefaultTaskScope<T>(fn: () => T): T {
  const runtimeContext = getRuntimeContext();
  if (runtimeContext?.agentId && runtimeContext.conversationId) {
    return fn();
  }
  return inTaskScope(fn);
}

function task_create(...args: Parameters<typeof taskCreateImpl>) {
  return withDefaultTaskScope(() => taskCreateImpl(...args));
}

function task_get(...args: Parameters<typeof taskGetImpl>) {
  return withDefaultTaskScope(() => taskGetImpl(...args));
}

function task_list(...args: Parameters<typeof taskListImpl>) {
  return withDefaultTaskScope(() => taskListImpl(...args));
}

function task_update(...args: Parameters<typeof taskUpdateImpl>) {
  return withDefaultTaskScope(() => taskUpdateImpl(...args));
}

describe("Task CRUD family", () => {
  beforeEach(() => {
    _resetTaskStoreForTests();
  });

  test("TaskCreate assigns sequential IDs and defaults to pending", async () => {
    const a = await task_create({
      subject: "First",
      description: "Do the first thing",
    });
    const b = await task_create({
      subject: "Second",
      description: "Do the second thing",
    });
    expect(a.taskId).toBe("task_1");
    expect(b.taskId).toBe("task_2");
    expect(a.status).toBe("pending");
    expect(a.blocks).toEqual([]);
    expect(a.blockedBy).toEqual([]);
    expect(a.metadata).toEqual({});
  });

  test("TaskCreate preserves activeForm and metadata", async () => {
    const t = await task_create({
      subject: "Run tests",
      description: "Execute the full test suite and report results",
      activeForm: "Running tests",
      metadata: { area: "qa", priority: "high" },
    });
    expect(t.activeForm).toBe("Running tests");
    expect(t.metadata).toEqual({ area: "qa", priority: "high" });
  });

  test("TaskCreate rejects missing required fields", async () => {
    await expect(task_create({ subject: "x" } as never)).rejects.toThrow(
      /description/,
    );
    await expect(task_create({ description: "x" } as never)).rejects.toThrow(
      /subject/,
    );
  });

  test("TaskCreate rejects execution without an agent/conversation scope", async () => {
    await expect(
      runOutsideRuntimeContext(() =>
        taskCreateImpl({ subject: "x", description: "y" }),
      ),
    ).rejects.toThrow(/agent and conversation execution scope/);
  });

  test("Task CRUD isolates concurrent agent and conversation scopes", async () => {
    const scopeA = { agentId: "agent-a", conversationId: "conversation-a" };
    const scopeB = { agentId: "agent-b", conversationId: "conversation-b" };

    const [taskA, taskB] = await Promise.all([
      inTaskScope(
        () => task_create({ subject: "A", description: "scope A" }),
        scopeA,
      ),
      inTaskScope(
        () => task_create({ subject: "B", description: "scope B" }),
        scopeB,
      ),
    ]);

    const [listA, listB] = await Promise.all([
      inTaskScope(() => task_list({}), scopeA),
      inTaskScope(() => task_list({}), scopeB),
    ]);

    expect(listA.tasks.map((task) => task.taskId)).toEqual([taskA.taskId]);
    expect(listB.tasks.map((task) => task.taskId)).toEqual([taskB.taskId]);
    await expect(
      inTaskScope(() => task_get({ taskId: taskA.taskId }), scopeB),
    ).rejects.toThrow(/not found/);
    await expect(
      inTaskScope(
        () => task_update({ taskId: taskA.taskId, status: "completed" }),
        scopeB,
      ),
    ).rejects.toThrow(/not found/);
  });

  test("Task CRUD isolates default conversations belonging to different agents", async () => {
    const agentA = { agentId: "agent-a", conversationId: "default" };
    const agentB = { agentId: "agent-b", conversationId: "default" };
    const taskA = await inTaskScope(
      () => task_create({ subject: "A", description: "agent A" }),
      agentA,
    );

    expect((await inTaskScope(() => task_list({}), agentB)).tasks).toEqual([]);
    await expect(
      inTaskScope(() => task_get({ taskId: taskA.taskId }), agentB),
    ).rejects.toThrow(/not found/);
  });

  test("clearing one task scope leaves other scopes intact", async () => {
    const scopeA = { agentId: "agent-a", conversationId: "conversation-a" };
    const scopeB = { agentId: "agent-b", conversationId: "conversation-b" };
    await inTaskScope(
      () => task_create({ subject: "A", description: "scope A" }),
      scopeA,
    );
    const taskB = await inTaskScope(
      () => task_create({ subject: "B", description: "scope B" }),
      scopeB,
    );

    expect(clearTaskStoreScope(scopeA)).toBe(true);
    expect((await inTaskScope(() => task_list({}), scopeA)).tasks).toEqual([]);
    expect(
      (await inTaskScope(() => task_list({}), scopeB)).tasks.map(
        (task) => task.taskId,
      ),
    ).toEqual([taskB.taskId]);
    expect(clearTaskStoreScope(scopeA)).toBe(false);
  });

  test("TaskCreate rejects non-string metadata values", async () => {
    await expect(
      task_create({
        subject: "x",
        description: "y",
        metadata: { bad: 123 as unknown as string },
      }),
    ).rejects.toThrow(/metadata/);
  });

  test("TaskGet returns the record for an existing task", async () => {
    const created = await task_create({ subject: "x", description: "y" });
    const fetched = await task_get({ taskId: created.taskId });
    expect(fetched.taskId).toBe(created.taskId);
    expect(fetched.subject).toBe("x");
  });

  test("TaskGet throws for unknown taskId", async () => {
    await expect(task_get({ taskId: "task_missing" })).rejects.toThrow(
      /not found/,
    );
  });

  test("TaskList returns tasks in creation order", async () => {
    await task_create({ subject: "a", description: "aa" });
    await task_create({ subject: "b", description: "bb" });
    await task_create({ subject: "c", description: "cc" });
    const { tasks } = await task_list({});
    expect(tasks.map((t) => t.subject)).toEqual(["a", "b", "c"]);
  });

  test("TaskList excludes soft-deleted tasks but TaskGet still returns them", async () => {
    const a = await task_create({ subject: "a", description: "aa" });
    await task_create({ subject: "b", description: "bb" });
    await task_update({ taskId: a.taskId, status: "deleted" });

    const { tasks } = await task_list({});
    expect(tasks.map((t) => t.subject)).toEqual(["b"]);

    const deleted = await task_get({ taskId: a.taskId });
    expect(deleted.status).toBe("deleted");
  });

  test("TaskUpdate transitions status through lifecycle", async () => {
    const t = await task_create({ subject: "x", description: "y" });

    const p1 = await task_update({ taskId: t.taskId, status: "in_progress" });
    expect(p1.status).toBe("in_progress");

    const p2 = await task_update({ taskId: t.taskId, status: "completed" });
    expect(p2.status).toBe("completed");
  });

  test("TaskUpdate rejects unknown status values", async () => {
    const t = await task_create({ subject: "x", description: "y" });
    await expect(
      task_update({ taskId: t.taskId, status: "unknown" }),
    ).rejects.toThrow(/status/);
  });

  test("TaskUpdate appends to blocks / blockedBy without duplicates", async () => {
    const a = await task_create({ subject: "a", description: "aa" });
    const b = await task_create({ subject: "b", description: "bb" });
    const c = await task_create({ subject: "c", description: "cc" });

    await task_update({
      taskId: a.taskId,
      addBlocks: [b.taskId, c.taskId, b.taskId],
    });
    const updated = await task_get({ taskId: a.taskId });
    expect(updated.blocks).toEqual([b.taskId, c.taskId]);

    await task_update({
      taskId: b.taskId,
      addBlockedBy: [a.taskId],
    });
    const b2 = await task_get({ taskId: b.taskId });
    expect(b2.blockedBy).toEqual([a.taskId]);
  });

  test("TaskUpdate merges metadata rather than replacing", async () => {
    const t = await task_create({
      subject: "x",
      description: "y",
      metadata: { a: "1", b: "2" },
    });

    const updated = await task_update({
      taskId: t.taskId,
      metadata: { b: "overwritten", c: "3" },
    });
    expect(updated.metadata).toEqual({ a: "1", b: "overwritten", c: "3" });
  });

  test("TaskUpdate sets owner, subject, description, activeForm", async () => {
    const t = await task_create({ subject: "old", description: "old" });
    const updated = await task_update({
      taskId: t.taskId,
      subject: "new",
      description: "new desc",
      activeForm: "Doing new",
      owner: "agent-abc",
    });
    expect(updated.subject).toBe("new");
    expect(updated.description).toBe("new desc");
    expect(updated.activeForm).toBe("Doing new");
    expect(updated.owner).toBe("agent-abc");
  });

  test("TaskUpdate throws for unknown taskId", async () => {
    await expect(
      task_update({ taskId: "task_missing", status: "completed" }),
    ).rejects.toThrow(/not found/);
  });

  test("TaskUpdate bumps updatedAt", async () => {
    const t = await task_create({ subject: "x", description: "y" });
    const originalUpdatedAt = t.updatedAt;
    // Busy-wait a ms so Date.now() moves forward
    await new Promise((r) => setTimeout(r, 2));
    const updated = await task_update({
      taskId: t.taskId,
      status: "in_progress",
    });
    expect(updated.updatedAt).toBeGreaterThan(originalUpdatedAt);
    expect(updated.createdAt).toBe(t.createdAt);
  });
});
