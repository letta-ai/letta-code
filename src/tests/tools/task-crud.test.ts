import { beforeEach, describe, expect, test } from "bun:test";
import { task_create } from "../../tools/impl/TaskCreate";
import { task_get } from "../../tools/impl/TaskGet";
import { task_list } from "../../tools/impl/TaskList";
import { task_update } from "../../tools/impl/TaskUpdate";
import { _resetTaskStoreForTests } from "../../tools/impl/tasks/store";

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
