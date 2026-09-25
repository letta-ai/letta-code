import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { debugLogFile } from "./debug";

describe("DebugLogFile", () => {
  let dir: string;
  let previousTelem: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "letta-debug-log-"));
    // The test preload sets LETTA_CODE_TELEM=0, which disables file logging.
    previousTelem = process.env.LETTA_CODE_TELEM;
    process.env.LETTA_CODE_TELEM = "1";
  });

  afterEach(() => {
    if (previousTelem === undefined) {
      delete process.env.LETTA_CODE_TELEM;
    } else {
      process.env.LETTA_CODE_TELEM = previousTelem;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("persists lines to the agent session file", () => {
    debugLogFile.init("agent-1", "session-1", { dir });
    debugLogFile.appendLine("hello\n");
    const content = readFileSync(join(dir, "agent-1", "session-1.log"), "utf8");
    expect(content).toContain("hello");
  });

  test("stops writing at the size cap and records one truncation notice", () => {
    debugLogFile.init("agent-1", "session-2", { dir, maxBytes: 128 });
    for (let i = 0; i < 50; i++) {
      debugLogFile.appendLine(`line ${i} ${"x".repeat(40)}\n`);
    }
    const path = join(dir, "agent-1", "session-2.log");
    const content = readFileSync(path, "utf8");
    expect(content).toContain("log truncated after 128 bytes");
    // Exactly one notice, no matter how many writes arrive past the cap.
    expect(content.match(/log truncated/g)?.length).toBe(1);
    // Size stays bounded: cap plus at most one in-flight line and the notice.
    expect(statSync(path).size).toBeLessThan(128 + 128 + 128);
  });

  test("a fresh session resets the cap accounting", () => {
    debugLogFile.init("agent-1", "session-3", { dir, maxBytes: 64 });
    for (let i = 0; i < 20; i++) {
      debugLogFile.appendLine(`line ${i} ${"x".repeat(40)}\n`);
    }
    debugLogFile.init("agent-1", "session-4", { dir, maxBytes: 64 });
    debugLogFile.appendLine("fresh session line\n");
    const content = readFileSync(join(dir, "agent-1", "session-4.log"), "utf8");
    expect(content).toContain("fresh session line");
    expect(content).not.toContain("log truncated");
  });
});
