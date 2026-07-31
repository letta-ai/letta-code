import { beforeEach, describe, expect, test } from "bun:test";
import { taskCrudTodos } from "@/cli/helpers/task-crud-rendering";
import {
  _resetTaskStoreForTests,
  createTask,
  updateTask,
} from "@/tools/impl/tasks/store";

describe("task CRUD rendering", () => {
  const scope = {
    agentId: "agent-render",
    conversationId: "conversation-render",
  };

  beforeEach(() => {
    _resetTaskStoreForTests();
  });

  test("projects only the requested scope into todo rows", () => {
    const task = createTask(scope, {
      subject: "Visible task",
      description: "Render this task",
    });
    createTask(
      { agentId: "other-agent", conversationId: "other-conversation" },
      {
        subject: "Hidden task",
        description: "Do not render this task",
      },
    );
    updateTask(scope, { taskId: task.taskId, status: "in_progress" });

    expect(taskCrudTodos(scope)).toEqual([
      {
        content: "Visible task",
        status: "in_progress",
        id: task.taskId,
      },
    ]);
  });

  test("preserves completed task status", () => {
    const task = createTask(scope, {
      subject: "Completed task",
      description: "Render completed status",
    });
    updateTask(scope, { taskId: task.taskId, status: "completed" });

    expect(taskCrudTodos(scope)).toEqual([
      {
        content: "Completed task",
        status: "completed",
        id: task.taskId,
      },
    ]);
  });
});
