import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import {
  appendToOutputFile,
  type BackgroundTask,
  backgroundTasks,
  createBackgroundOutputFile,
  getNextTaskId,
} from "../../tools/impl/process_manager";
import { task_output } from "../../tools/impl/TaskOutput";
import { task_stop } from "../../tools/impl/TaskStop";

/**
 * Tests for Task background execution infrastructure.
 *
 * Since the full task() function requires subagent infrastructure,
 * these tests verify the background task tracking, output file handling,
 * and integration with TaskOutput/TaskStop tools.
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
      subagentType: "explore",
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

describe("TaskOutput with background tasks", () => {
  afterEach(() => {
    backgroundTasks.clear();
  });

  test("TaskOutput retrieves output from background task", async () => {
    const taskId = "task_output_test_1";
    const outputFile = createBackgroundOutputFile(taskId);

    const bgTask: BackgroundTask = {
      description: "Test retrieval",
      subagentType: "explore",
      subagentId: "subagent_2",
      status: "completed",
      output: ["Task completed successfully", "Found 5 files"],
      startTime: new Date(),
      outputFile,
    };

    backgroundTasks.set(taskId, bgTask);

    const result = await task_output({
      task_id: taskId,
      block: false,
      timeout: 1000,
    });

    expect(result.message).toContain("Task completed successfully");
    expect(result.message).toContain("Found 5 files");
    expect(result.status).toBe("completed");

    // Clean up
    fs.unlinkSync(outputFile);
  });

  test("TaskOutput includes error in output", async () => {
    const taskId = "task_error_test";
    const outputFile = createBackgroundOutputFile(taskId);

    const bgTask: BackgroundTask = {
      description: "Test error",
      subagentType: "general-purpose",
      subagentId: "subagent_3",
      status: "failed",
      output: ["Started processing"],
      error: "Connection timeout",
      startTime: new Date(),
      outputFile,
    };

    backgroundTasks.set(taskId, bgTask);

    const result = await task_output({
      task_id: taskId,
      block: false,
      timeout: 1000,
    });

    expect(result.message).toContain("Started processing");
    expect(result.message).toContain("Connection timeout");
    expect(result.status).toBe("failed");

    // Clean up
    fs.unlinkSync(outputFile);
  });

  test("TaskOutput with block=true waits for task completion", async () => {
    const taskId = "task_block_test";
    const outputFile = createBackgroundOutputFile(taskId);

    const bgTask: BackgroundTask = {
      description: "Test blocking",
      subagentType: "explore",
      subagentId: "subagent_4",
      status: "running",
      output: [],
      startTime: new Date(),
      outputFile,
    };

    backgroundTasks.set(taskId, bgTask);

    // Simulate task completing after 200ms
    setTimeout(() => {
      bgTask.status = "completed";
      bgTask.output.push("Task finished");
    }, 200);

    const startTime = Date.now();
    const result = await task_output({
      task_id: taskId,
      block: true,
      timeout: 5000,
    });
    const elapsed = Date.now() - startTime;

    // Should have waited for the task to complete
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(result.status).toBe("completed");
    expect(result.message).toContain("Task finished");

    // Clean up
    fs.unlinkSync(outputFile);
  });

  test("TaskOutput respects timeout when blocking", async () => {
    const taskId = "task_timeout_test";
    const outputFile = createBackgroundOutputFile(taskId);

    const bgTask: BackgroundTask = {
      description: "Test timeout",
      subagentType: "explore",
      subagentId: "subagent_5",
      status: "running",
      output: ["Still running..."],
      startTime: new Date(),
      outputFile,
    };

    backgroundTasks.set(taskId, bgTask);

    const startTime = Date.now();
    const result = await task_output({
      task_id: taskId,
      block: true,
      timeout: 300, // Short timeout
    });
    const elapsed = Date.now() - startTime;

    // Should have timed out around 300ms
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(1000);
    expect(result.status).toBe("running"); // Still running after timeout

    // Clean up
    fs.unlinkSync(outputFile);
  });

  test("TaskOutput handles non-existent task_id", async () => {
    const result = await task_output({
      task_id: "nonexistent_task",
      block: false,
      timeout: 1000,
    });

    expect(result.message).toContain("No background process found");
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

    const bgTask: BackgroundTask = {
      description: "Test abort",
      subagentType: "general-purpose",
      subagentId: "subagent_6",
      status: "running",
      output: [],
      startTime: new Date(),
      outputFile,
      abortController,
    };

    backgroundTasks.set(taskId, bgTask);

    // Verify task is running
    expect(bgTask.status).toBe("running");
    expect(abortController.signal.aborted).toBe(false);

    // Stop the task
    const result = await task_stop({ task_id: taskId });

    expect(result.killed).toBe(true);
    expect(bgTask.status).toBe("failed");
    expect(bgTask.error).toBe("Aborted by user");
    expect(abortController.signal.aborted).toBe(true);

    // Clean up
    fs.unlinkSync(outputFile);
  });

  test("TaskStop returns false for completed task", async () => {
    const taskId = "task_stop_completed";
    const outputFile = createBackgroundOutputFile(taskId);

    const bgTask: BackgroundTask = {
      description: "Completed task",
      subagentType: "explore",
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
      subagentType: "explore",
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
    appendToOutputFile(outputFile, `[subagent_type: explore]\n\n`);
    appendToOutputFile(
      outputFile,
      `subagent_type=explore agent_id=agent-123\n\n`,
    );
    appendToOutputFile(outputFile, `Found authentication code in src/auth/\n`);
    appendToOutputFile(outputFile, `\n[Task completed]\n`);

    const content = fs.readFileSync(outputFile, "utf-8");

    expect(content).toContain("[Task started: Find auth code]");
    expect(content).toContain("[subagent_type: explore]");
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
