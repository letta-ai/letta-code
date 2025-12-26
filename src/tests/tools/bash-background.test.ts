import { describe, expect, test } from "bun:test";
import { bash } from "../../tools/impl/Bash";
import { bash_output } from "../../tools/impl/BashOutput";
import { kill_bash } from "../../tools/impl/KillBash";

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
});
