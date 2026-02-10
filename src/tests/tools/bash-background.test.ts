import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { bash } from "../../tools/impl/Bash";
import { bash_output } from "../../tools/impl/BashOutput";
import { kill_bash } from "../../tools/impl/KillBash";
import { backgroundProcesses } from "../../tools/impl/process_manager";

const isWindows = process.platform === "win32";

// These tests use bash-specific syntax (echo with quotes, sleep)
describe.skipIf(isWindows)("Bash background tools", () => {
  test("starts background process and returns ID in text", async () => {
    const result = await bash({
      command: "echo 'test'",
      description: "Test background",
      run_in_background: true,
    });

    expect(result.content[0]?.text).toContain("background with ID:");
    expect(result.content[0]?.text).toMatch(/bash_\d+/);
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
});
