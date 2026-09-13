import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { SUBAGENT_STDOUT_LOST_MARKER } from "@/utils/subagent-stdout-failure";

const guardUrl = new URL("./headless-stdout-guard.ts", import.meta.url).href;

function runWithStdoutError(options: {
  env?: Record<string, string>;
  code?: string;
}): { status: number | null; stderr: string } {
  const script = [
    `const { installHeadlessStdoutGuard } = await import(${JSON.stringify(guardUrl)});`,
    "installHeadlessStdoutGuard();",
    `process.stdout.emit("error", Object.assign(new Error("stream failed"), { code: ${JSON.stringify(options.code ?? "EPIPE")} }));`,
    // Only reached if the handler neither exited nor threw.
    "process.exit(42);",
  ].join("\n");

  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, LETTA_PARENT_AGENT_ID: "", ...options.env },
    encoding: "utf-8",
    timeout: 15_000,
  });
  return { status: result.status, stderr: result.stderr ?? "" };
}

describe("installHeadlessStdoutGuard", () => {
  test("subagent child exits 1 with the marker flushed to stderr", () => {
    const { status, stderr } = runWithStdoutError({
      env: { LETTA_PARENT_AGENT_ID: "agent-parent-1" },
    });
    expect(status).toBe(1);
    expect(stderr).toContain(SUBAGENT_STDOUT_LOST_MARKER);
    expect(stderr).toContain("EPIPE");
  });

  test("non-subagent EPIPE stays a clean exit 0", () => {
    const { status, stderr } = runWithStdoutError({});
    expect(status).toBe(0);
    expect(stderr).not.toContain(SUBAGENT_STDOUT_LOST_MARKER);
  });

  test("subagent child reports non-EPIPE stdout errors too", () => {
    const { status, stderr } = runWithStdoutError({
      env: { LETTA_PARENT_AGENT_ID: "agent-parent-1" },
      code: "ERR_STREAM_DESTROYED",
    });
    expect(status).toBe(1);
    expect(stderr).toContain(SUBAGENT_STDOUT_LOST_MARKER);
    expect(stderr).toContain("ERR_STREAM_DESTROYED");
  });
});
