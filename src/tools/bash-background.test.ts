import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bash } from "@/tools/impl/bash";
import { bash_output } from "@/tools/impl/bash-output";
import { kill_bash } from "@/tools/impl/kill-bash";
import {
  __resetBackgroundRetentionConfigForTests,
  __setBackgroundRetentionConfigForTests,
  backgroundProcesses,
} from "@/tools/impl/process_manager";

const isWindows = process.platform === "win32";

// These tests use bash-specific syntax (echo with quotes, sleep)
describe.skipIf(isWindows)("Bash background tools", () => {
  beforeEach(() => {
    __resetBackgroundRetentionConfigForTests();
  });

  afterEach(() => {
    __resetBackgroundRetentionConfigForTests();
    const outputFiles = Array.from(backgroundProcesses.values())
      .map((proc) => proc.outputFile)
      .filter((filePath): filePath is string => Boolean(filePath));
    for (const proc of backgroundProcesses.values()) {
      try {
        proc.process.kill("SIGTERM");
      } catch {
        // Ignore cleanup failures for already-exited processes
      }
    }
    backgroundProcesses.clear();
    for (const outputFile of outputFiles) {
      if (fs.existsSync(outputFile)) {
        fs.rmSync(outputFile, { recursive: true, force: true });
      }
    }
  });

  test("starts background process and returns ID in text", async () => {
    const runtimeScope = { agentId: "agent-1", conversationId: "conv-1" };
    const result = await bash({
      command: "echo 'test'",
      description: "Test background",
      run_in_background: true,
      parentScope: runtimeScope,
    });

    expect(result.content[0]?.text).toContain("background with ID:");
    expect(result.content[0]?.text).toMatch(/bash_\d+/);
    const bashId = result.content[0]?.text.match(/bash_\d+/)?.[0];
    expect(backgroundProcesses.get(bashId ?? "")?.runtimeScope).toEqual(
      runtimeScope,
    );
  });

  test("fails a background process when its output file cannot be written", async () => {
    const result = await bash({
      command: "printf 'start\\n'; sleep 1; printf 'after\\n'; sleep 30",
      description: "Test output write failure",
      run_in_background: true,
    });
    const bashId = result.content[0]?.text.match(/bash_\d+/)?.[0];
    expect(bashId).toBeDefined();

    const processState = backgroundProcesses.get(bashId ?? "");
    expect(processState?.outputFile).toBeDefined();
    fs.rmSync(processState?.outputFile ?? "", { force: true });
    fs.mkdirSync(processState?.outputFile ?? "");

    await new Promise((resolve) => setTimeout(resolve, 1_250));

    expect(backgroundProcesses.get(bashId ?? "")?.status).toBe("failed");
  });

  test("BashOutput retrieves output from background shell", async () => {
    // Start background process
    const startResult = await bash({
      command: "echo 'background output'",
      description: "Test background",
      run_in_background: true,
    });

    // Extract shell_id from the response text
    const match = startResult.content[0]?.text.match(/bash_(\d+)/);
    expect(match).toBeDefined();
    const bashId = `bash_${match?.[1]}`;

    // Wait for command to complete
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Retrieve output
    const outputResult = await bash_output({ shell_id: bashId });

    expect(outputResult.message).toContain("background output");
  });

  test("BashOutput handles non-existent shell_id gracefully", async () => {
    const result = await bash_output({ shell_id: "nonexistent" });

    expect(result.message).toContain("No background process found");
  });

  test("KillBash terminates background process", async () => {
    // Start long-running process
    const startResult = await bash({
      command: "sleep 10",
      description: "Test kill",
      run_in_background: true,
    });

    const match = startResult.content[0]?.text.match(/bash_(\d+)/);
    const bashId = `bash_${match?.[1]}`;

    // Kill it (KillBash uses shell_id parameter)
    const killResult = await kill_bash({ shell_id: bashId });

    expect(killResult.killed).toBe(true);
  });

  test("KillBash handles non-existent shell_id", async () => {
    const result = await kill_bash({ shell_id: "nonexistent" });

    expect(result.killed).toBe(false);
  });

  test("KillBash preserves completed-process cleanup behavior", async () => {
    let killed = false;
    backgroundProcesses.set("bash_completed", {
      process: {
        kill() {
          killed = true;
        },
      },
      command: "echo done",
      stdout: [],
      stderr: [],
      status: "completed",
      exitCode: 0,
      lastReadIndex: { stdout: 0, stderr: 0 },
    });

    expect(await kill_bash({ shell_id: "bash_completed" })).toEqual({
      killed: true,
    });
    expect(killed).toBe(true);
    expect(backgroundProcesses.has("bash_completed")).toBe(false);
  });

  test("background process returns output file path", async () => {
    const result = await bash({
      command: "echo 'test'",
      description: "Test output file",
      run_in_background: true,
    });

    expect(result.content[0]?.text).toContain("Output file:");
    expect(result.content[0]?.text).toMatch(/\.log$/);
  });

  test("background process writes to output file", async () => {
    const startResult = await bash({
      command: "echo 'file output test'",
      description: "Test file writing",
      run_in_background: true,
    });

    // Extract bash ID and get the output file path
    const match = startResult.content[0]?.text.match(/bash_(\d+)/);
    expect(match).toBeDefined();
    const bashId = `bash_${match?.[1]}`;

    // Wait for command to complete
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Get the output file path from the background process
    const bgProcess = backgroundProcesses.get(bashId);
    expect(bgProcess?.outputFile).toBeDefined();

    // Read the file and verify content
    const outputFile = bgProcess?.outputFile;
    expect(outputFile).toBeDefined();
    const fileContent = fs.readFileSync(outputFile as string, "utf-8");
    expect(fileContent).toContain("file output test");
  });

  test("background process keeps only the recent stdout tail in memory", async () => {
    __setBackgroundRetentionConfigForTests({
      completedEntryTtlMs: 60_000,
      maxProcessLinesPerStream: 3,
      maxProcessCharsPerStream: 1_000,
    });

    const startResult = await bash({
      command: "printf 'one\\ntwo\\nthree\\nfour\\n'",
      description: "Tail retention",
      run_in_background: true,
    });

    const match = startResult.content[0]?.text.match(/bash_(\d+)/);
    expect(match).toBeDefined();
    const bashId = `bash_${match?.[1]}`;

    await new Promise((resolve) => setTimeout(resolve, 200));

    const bgProcess = backgroundProcesses.get(bashId);
    expect(bgProcess?.stdout).toEqual(["two", "three", "four"]);
    expect(bgProcess?.outputFile).toBeDefined();

    const fileContent = fs.readFileSync(
      bgProcess?.outputFile as string,
      "utf-8",
    );
    expect(fileContent).toContain("one");
    expect(fileContent).toContain("four");
  });

  test("completed background processes are evicted after the retention window", async () => {
    __setBackgroundRetentionConfigForTests({ completedEntryTtlMs: 150 });

    const startResult = await bash({
      command: "echo 'cleanup'",
      description: "Cleanup retention",
      run_in_background: true,
    });

    const match = startResult.content[0]?.text.match(/bash_(\d+)/);
    expect(match).toBeDefined();
    const bashId = `bash_${match?.[1]}`;

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(backgroundProcesses.has(bashId)).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(backgroundProcesses.has(bashId)).toBe(false);
  });

  test("refuses to start a new background process after the running cap", async () => {
    __setBackgroundRetentionConfigForTests({ maxRunningProcesses: 1 });

    const first = await bash({
      command: "sleep 10",
      description: "First running process",
      run_in_background: true,
    });
    expect(first.status).toBe("success");

    const second = await bash({
      command: "sleep 10",
      description: "Second running process",
      run_in_background: true,
    });

    expect(second.status).toBe("error");
    expect(second.content[0]?.text).toContain(
      "Too many background processes already running",
    );
  });

  test("background timeout force-kills the whole process tree", async () => {
    const tempDir = fs.mkdtempSync(join(tmpdir(), "letta-bash-tree-"));
    const descendantPath = join(tempDir, "descendant.cjs");
    const launcherPath = join(tempDir, "launcher.cjs");
    fs.writeFileSync(
      descendantPath,
      [
        'process.on("SIGTERM", () => {});',
        "setTimeout(() => process.exit(0), 7000);",
        "setInterval(() => {}, 1000);",
      ].join(""),
    );
    fs.writeFileSync(
      launcherPath,
      [
        'const { spawn } = require("node:child_process");',
        `const descendant = spawn(process.execPath, [${JSON.stringify(descendantPath)}], { stdio: "inherit" });`,
        'process.stdout.write("descendant:" + descendant.pid + "\\n");',
        'process.on("SIGTERM", () => {});',
        "setTimeout(() => process.exit(0), 7000);",
        "setInterval(() => {}, 1000);",
      ].join(""),
    );

    try {
      const result = await bash({
        command: `node ${JSON.stringify(launcherPath)}`,
        description: "Test background process tree timeout",
        run_in_background: true,
        timeout: 200,
      });
      const bashId = result.content[0]?.text.match(/bash_\d+/)?.[0];
      expect(bashId).toBeDefined();
      if (!bashId) throw new Error("Expected background Bash id");

      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (backgroundProcesses.get(bashId)?.status !== "running") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const processEntry = backgroundProcesses.get(bashId);
      expect(processEntry?.status).toBe("failed");
      expect(processEntry?.stderr.join("\n")).toContain(
        "Command timed out after 200ms",
      );
      const descendantPid = Number(
        processEntry?.stdout.join("\n").match(/descendant:(\d+)/)?.[1],
      );
      expect(descendantPid).toBeGreaterThan(0);
      expect(() => process.kill(descendantPid, 0)).toThrow();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10_000);
});
