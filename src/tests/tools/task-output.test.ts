import { describe, expect, test } from "bun:test";
import { bash } from "../../tools/impl/Bash";
import { backgroundProcesses } from "../../tools/impl/process_manager";
import { task_output } from "../../tools/impl/TaskOutput";
import { task_stop } from "../../tools/impl/TaskStop";

const isWindows = process.platform === "win32";

describe.skipIf(isWindows)("TaskOutput and TaskStop", () => {
  test("TaskOutput with block=false returns immediately without waiting", async () => {
    // Start a slow background process
    const startResult = await bash({
      command: "sleep 2 && echo 'done'",
      description: "Slow process",
      run_in_background: true,
    });

    const match = startResult.content[0]?.text.match(/bash_(\d+)/);
    expect(match).toBeDefined();
    const taskId = `bash_${match?.[1]}`;

    // Non-blocking call should return immediately
    const startTime = Date.now();
    const result = await task_output({
      task_id: taskId,
      block: false,
      timeout: 30000,
    });
    const elapsed = Date.now() - startTime;

    // Should return in less than 500ms (not waiting for 2s sleep)
    expect(elapsed).toBeLessThan(500);
    expect(result.status).toBe("running");
    expect(result.message).toContain("Task is still running");

    // Cleanup
    await task_stop({ task_id: taskId });
  });

  test("TaskOutput with block=true waits for completion", async () => {
    // Start a quick background process
    const startResult = await bash({
      command: "sleep 0.3 && echo 'completed'",
      description: "Quick process",
      run_in_background: true,
    });

    const match = startResult.content[0]?.text.match(/bash_(\d+)/);
    expect(match).toBeDefined();
    const taskId = `bash_${match?.[1]}`;

    // Blocking call should wait for completion
    const result = await task_output({
      task_id: taskId,
      block: true,
      timeout: 5000,
    });

    // Should have waited and gotten the output
    expect(result.message).toContain("completed");
    expect(result.status).toBe("completed");
  });

  test("TaskOutput with block=true streams output chunks", async () => {
    const startResult = await bash({
      command: "sleep 0.2 && echo 'first' && sleep 0.2 && echo 'second'",
      description: "Streaming process",
      run_in_background: true,
    });

    const match = startResult.content[0]?.text.match(/bash_(\d+)/);
    expect(match).toBeDefined();
    const taskId = `bash_${match?.[1]}`;

    const outputChunks: string[] = [];
    const result = await task_output({
      task_id: taskId,
      block: true,
      timeout: 5000,
      onOutput: (chunk) => outputChunks.push(chunk),
    });

    const streamed = outputChunks.join("");
    expect(streamed).toContain("first");
    expect(streamed).toContain("second");
    expect(result.status).toBe("completed");
  });

  test("TaskOutput respects timeout when blocking", async () => {
    // Start a long-running process
    const startResult = await bash({
      command: "sleep 10",
      description: "Long process",
      run_in_background: true,
    });

    const match = startResult.content[0]?.text.match(/bash_(\d+)/);
    expect(match).toBeDefined();
    const taskId = `bash_${match?.[1]}`;

    // Block with short timeout
    const startTime = Date.now();
    const result = await task_output({
      task_id: taskId,
      block: true,
      timeout: 300, // 300ms timeout
    });
    const elapsed = Date.now() - startTime;

    // Should have timed out around 300ms, not waited for 10s
    expect(elapsed).toBeLessThan(1000);
    expect(elapsed).toBeGreaterThanOrEqual(250); // Allow some tolerance
    expect(result.status).toBe("running"); // Still running after timeout

    // Cleanup
    await task_stop({ task_id: taskId });
  });

  test("TaskOutput handles non-existent task_id", async () => {
    const result = await task_output({
      task_id: "nonexistent_task",
      block: false,
      timeout: 1000,
    });

    expect(result.message).toContain("No background process found");
  });

  test("TaskStop terminates process using task_id", async () => {
    // Start long-running process
    const startResult = await bash({
      command: "sleep 10",
      description: "Process to kill",
      run_in_background: true,
    });

    const match = startResult.content[0]?.text.match(/bash_(\d+)/);
    const taskId = `bash_${match?.[1]}`;

    // Kill using task_id
    const killResult = await task_stop({ task_id: taskId });

    expect(killResult.killed).toBe(true);

    // Verify process is gone
    expect(backgroundProcesses.has(taskId)).toBe(false);
  });

  test("TaskStop supports deprecated shell_id parameter", async () => {
    // Start long-running process
    const startResult = await bash({
      command: "sleep 10",
      description: "Process to kill",
      run_in_background: true,
    });

    const match = startResult.content[0]?.text.match(/bash_(\d+)/);
    const shellId = `bash_${match?.[1]}`;

    // Kill using deprecated shell_id
    const killResult = await task_stop({ shell_id: shellId });

    expect(killResult.killed).toBe(true);
  });

  test("TaskStop handles non-existent task_id", async () => {
    const result = await task_stop({ task_id: "nonexistent" });

    expect(result.killed).toBe(false);
  });

  test("TaskOutput defaults to block=true", async () => {
    // Start a quick background process
    const startResult = await bash({
      command: "sleep 0.2 && echo 'default-block-test'",
      description: "Default block test",
      run_in_background: true,
    });

    const match = startResult.content[0]?.text.match(/bash_(\d+)/);
    const taskId = `bash_${match?.[1]}`;

    // Call without specifying block - should default to true
    const result = await task_output({
      task_id: taskId,
      timeout: 5000,
    });

    // Should have waited and gotten the output
    expect(result.message).toContain("default-block-test");
    expect(result.status).toBe("completed");
  });
});
