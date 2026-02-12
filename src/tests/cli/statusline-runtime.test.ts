import { describe, expect, test } from "bun:test";
import { executeStatusLineCommand } from "../../cli/helpers/statusLineRuntime";

const isWindows = process.platform === "win32";

describe.skipIf(isWindows)("executeStatusLineCommand", () => {
  test("echo command returns stdout", async () => {
    const result = await executeStatusLineCommand(
      "echo hello",
      {},
      {
        timeout: 5000,
      },
    );
    expect(result.ok).toBe(true);
    expect(result.text).toBe("hello");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("receives JSON payload on stdin", async () => {
    // cat reads stdin and outputs it; we verify the command receives JSON
    const result = await executeStatusLineCommand(
      "cat",
      {
        agent_id: "test-agent",
        streaming: false,
      },
      {
        timeout: 5000,
      },
    );
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.text);
    expect(parsed.agent_id).toBe("test-agent");
    expect(parsed.streaming).toBe(false);
  });

  test("non-zero exit code returns ok: false", async () => {
    const result = await executeStatusLineCommand(
      "exit 1",
      {},
      {
        timeout: 5000,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Exit code");
  });

  test("command timeout", async () => {
    const result = await executeStatusLineCommand(
      "sleep 10",
      {},
      {
        timeout: 500,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("timed out");
  });

  test("AbortSignal cancellation", async () => {
    const ac = new AbortController();
    const promise = executeStatusLineCommand(
      "sleep 10",
      {},
      {
        timeout: 10000,
        signal: ac.signal,
      },
    );

    // Abort after a short delay
    setTimeout(() => ac.abort(), 100);

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Aborted");
  });

  test("stdout is capped at 4KB", async () => {
    // Generate 8KB of output (each 'x' char is ~1 byte)
    const result = await executeStatusLineCommand(
      "python3 -c \"print('x' * 8192)\"",
      {},
      { timeout: 5000 },
    );
    expect(result.ok).toBe(true);
    // Stdout should be truncated to approximately 4KB
    expect(result.text.length).toBeLessThanOrEqual(4096);
  });

  test("empty command returns error", async () => {
    const result = await executeStatusLineCommand(
      "",
      {},
      {
        timeout: 5000,
      },
    );
    expect(result.ok).toBe(false);
  });

  test("pre-aborted signal returns immediately", async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await executeStatusLineCommand(
      "echo hi",
      {},
      {
        timeout: 5000,
        signal: ac.signal,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Aborted");
    expect(result.durationMs).toBe(0);
  });
});
