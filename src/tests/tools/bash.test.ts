import { describe, expect, test } from "bun:test";
import { bash } from "../../tools/impl/Bash";

describe("Bash tool", () => {
  test("executes simple command", async () => {
    const result = await bash({
      command: "echo 'Hello, World!'",
      description: "Test echo",
    });

    expect(result.content).toBeDefined();
    expect(result.content[0]?.text).toContain("Hello, World!");
    expect(result.status).toBe("success");
  });

  test("captures stderr in output", async () => {
    const result = await bash({
      command: "echo 'error message' >&2",
      description: "Test stderr",
    });

    expect(result.content[0]?.text).toContain("error message");
  });

  test("returns error for failed command", async () => {
    const result = await bash({
      command: "exit 1",
      description: "Test exit code",
    });

    expect(result.status).toBe("error");
    expect(result.content[0]?.text).toContain("Exit code");
  });

  test("times out long-running command", async () => {
    const result = await bash({
      command: "sleep 10",
      description: "Test timeout",
      timeout: 100,
    });

    expect(result.status).toBe("error");
    expect(result.content[0]?.text).toContain("timed out");
  }, 2000);

  test("runs command in background mode", async () => {
    const result = await bash({
      command: "echo 'background'",
      description: "Test background",
      run_in_background: true,
    });

    expect(result.content[0]?.text).toContain("background with ID:");
    expect(result.content[0]?.text).toMatch(/bash_\d+/);
  });

  test("handles complex commands with pipes", async () => {
    // Skip on Windows - pipe syntax is different
    if (process.platform === "win32") {
      return;
    }

    const result = await bash({
      command: "echo -e 'foo\\nbar\\nbaz' | grep bar",
      description: "Test pipe",
    });

    expect(result.content[0]?.text).toContain("bar");
    expect(result.content[0]?.text).not.toContain("foo");
  });

  test("lists background processes with /bg command", async () => {
    const result = await bash({
      command: "/bg",
      description: "List processes",
    });

    expect(result.content).toBeDefined();
    expect(result.content[0]?.text).toBeDefined();
  });

  test("throws error when command is missing", async () => {
    await expect(bash({} as Parameters<typeof bash>[0])).rejects.toThrow(
      /missing required parameter.*command/,
    );
  });
});
