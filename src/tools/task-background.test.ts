import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import {
  appendToOutputFile,
  type BackgroundTask,
  backgroundTasks,
  createBackgroundOutputFile,
  getNextTaskId,
} from "@/tools/impl/process_manager";
import { task_stop } from "@/tools/impl/task-stop";

/**
 * Tests for Task background execution infrastructure.
 *
 * Since the full task() function requires subagent infrastructure,
 * these tests verify the background task tracking, output file handling,
 * and integration with the TaskStop tool.
 */

describe("Task background infrastructure", () => {
  // Clean up after each test
  afterEach(() => {
    // Clear all background tasks
    backgroundTasks.clear();
  });

  test("getNextTaskId generates sequential IDs", () => {
    const id1 = getNextTaskId();
    const id2 = getNextTaskId();
    const id3 = getNextTaskId();

    expect(id1).toMatch(/^task_\d+$/);
    expect(id2).toMatch(/^task_\d+$/);
    expect(id3).toMatch(/^task_\d+$/);

    // Extract numbers and verify they're sequential
    const num1 = parseInt(id1.replace("task_", ""), 10);
    const num2 = parseInt(id2.replace("task_", ""), 10);
    const num3 = parseInt(id3.replace("task_", ""), 10);

    expect(num2).toBe(num1 + 1);
    expect(num3).toBe(num2 + 1);
  });

  test("createBackgroundOutputFile creates file and returns path", () => {
    const taskId = getNextTaskId();
    const outputFile = createBackgroundOutputFile(taskId);

    expect(outputFile).toContain(taskId);
    expect(outputFile).toMatch(/\.log$/);
    expect(fs.existsSync(outputFile)).toBe(true);

    // Clean up
    fs.unlinkSync(outputFile);
  });

  test("appendToOutputFile writes content to file", () => {
    const taskId = getNextTaskId();
    const outputFile = createBackgroundOutputFile(taskId);

    appendToOutputFile(outputFile, "First line\n");
    appendToOutputFile(outputFile, "Second line\n");

    const content = fs.readFileSync(outputFile, "utf-8");
    expect(content).toBe("First line\nSecond line\n");

    // Clean up
    fs.unlinkSync(outputFile);
  });

  test("backgroundTasks map stores and retrieves tasks", () => {
    const taskId = "task_test_1";
    const outputFile = createBackgroundOutputFile(taskId);

    const bgTask: BackgroundTask = {
      description: "Test task",
      subagentType: "general-purpose",
      subagentId: "subagent_1",
      status: "running",
      output: [],
      startTime: new Date(),
      outputFile,
      abortController: new AbortController(),
    };

    backgroundTasks.set(taskId, bgTask);

    expect(backgroundTasks.has(taskId)).toBe(true);
    expect(backgroundTasks.get(taskId)?.description).toBe("Test task");
    expect(backgroundTasks.get(taskId)?.status).toBe("running");

    // Clean up
    fs.unlinkSync(outputFile);
  });
});

describe("TaskStop with background tasks", () => {
  afterEach(() => {
    backgroundTasks.clear();
  });

  test("TaskStop aborts running task", async () => {
    const taskId = "task_stop_test";
    const outputFile = createBackgroundOutputFile(taskId);
    const abortController = new AbortController();
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });

    const bgTask: BackgroundTask = {
      description: "Test abort",
      subagentType: "general-purpose",
      subagentId: "subagent_6",
      status: "running",
      output: [],
      startTime: new Date(),
      outputFile,
      abortController,
      completion,
    };

    backgroundTasks.set(taskId, bgTask);

    // Verify task is running
    expect(bgTask.status).toBe("running");
    expect(abortController.signal.aborted).toBe(false);

    // Stop the task
    let stopFinished = false;
    const stopPromise = task_stop({ task_id: taskId }).then((result) => {
      stopFinished = true;
      return result;
    });
    await Promise.resolve();

    expect(stopFinished).toBe(false);
    expect(bgTask.status).toBe("running");
    expect(bgTask.error).toBe("Aborted by user");
    expect(abortController.signal.aborted).toBe(true);

    resolveCompletion();
    const result = await stopPromise;

    expect(result.killed).toBe(true);
    expect(bgTask.status).toBe("failed");

    // Clean up
    fs.unlinkSync(outputFile);
  });

  test("TaskStop returns false for completed task", async () => {
    const taskId = "task_stop_completed";
    const outputFile = createBackgroundOutputFile(taskId);

    const bgTask: BackgroundTask = {
      description: "Completed task",
      subagentType: "general-purpose",
      subagentId: "subagent_7",
      status: "completed",
      output: ["Done"],
      startTime: new Date(),
      outputFile,
    };

    backgroundTasks.set(taskId, bgTask);

    // Try to stop completed task
    const result = await task_stop({ task_id: taskId });

    expect(result.killed).toBe(false);
    expect(bgTask.status).toBe("completed"); // Status unchanged

    // Clean up
    fs.unlinkSync(outputFile);
  });

  test("TaskStop returns false for task without abortController", async () => {
    const taskId = "task_stop_no_abort";
    const outputFile = createBackgroundOutputFile(taskId);

    const bgTask: BackgroundTask = {
      description: "Task without abort",
      subagentType: "general-purpose",
      subagentId: "subagent_8",
      status: "running",
      output: [],
      startTime: new Date(),
      outputFile,
      // No abortController
    };

    backgroundTasks.set(taskId, bgTask);

    const result = await task_stop({ task_id: taskId });

    expect(result.killed).toBe(false);

    // Clean up
    fs.unlinkSync(outputFile);
  });

  test("TaskStop handles non-existent task_id", async () => {
    const result = await task_stop({ task_id: "nonexistent_task" });

    expect(result.killed).toBe(false);
  });
});

describe("Output file integration", () => {
  afterEach(() => {
    backgroundTasks.clear();
  });

  test("Output file contains task progress", () => {
    const taskId = "task_file_test";
    const outputFile = createBackgroundOutputFile(taskId);

    // Simulate the output that Task.ts writes
    appendToOutputFile(outputFile, `[Task started: Find auth code]\n`);
    appendToOutputFile(outputFile, `[subagent_type: general-purpose]\n\n`);
    appendToOutputFile(
      outputFile,
      `subagent_type=general-purpose agent_id=agent-123\n\n`,
    );
    appendToOutputFile(outputFile, `Found authentication code in src/auth/\n`);
    appendToOutputFile(outputFile, `\n[Task completed]\n`);

    const content = fs.readFileSync(outputFile, "utf-8");

    expect(content).toContain("[Task started: Find auth code]");
    expect(content).toContain("[subagent_type: general-purpose]");
    expect(content).toContain("agent_id=agent-123");
    expect(content).toContain("Found authentication code");
    expect(content).toContain("[Task completed]");

    // Clean up
    fs.unlinkSync(outputFile);
  });

  test("Output file contains error information", () => {
    const taskId = "task_file_error";
    const outputFile = createBackgroundOutputFile(taskId);

    // Simulate error output
    appendToOutputFile(outputFile, `[Task started: Complex analysis]\n`);
    appendToOutputFile(outputFile, `[subagent_type: general-purpose]\n\n`);
    appendToOutputFile(outputFile, `[error] Model rate limit exceeded\n`);
    appendToOutputFile(outputFile, `\n[Task failed]\n`);

    const content = fs.readFileSync(outputFile, "utf-8");

    expect(content).toContain("[Task started: Complex analysis]");
    expect(content).toContain("[error] Model rate limit exceeded");
    expect(content).toContain("[Task failed]");

    // Clean up
    fs.unlinkSync(outputFile);
  });
});
