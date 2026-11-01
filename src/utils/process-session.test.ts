import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ProcessSessionRecord,
  processSessionPath,
  recordProcessSession,
} from "./process-session";

describe("process session record", () => {
  let configDir: string;
  const saved = process.env.LETTA_CONFIG_DIR;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "letta-process-session-"));
    process.env.LETTA_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.LETTA_CONFIG_DIR;
    else process.env.LETTA_CONFIG_DIR = saved;
    rmSync(configDir, { recursive: true, force: true });
  });

  test("names this process's open conversation in sessions/<pid>.json, and follows each switch", () => {
    const path = processSessionPath();
    expect(path).toBe(join(configDir, "sessions", `${process.pid}.json`));

    recordProcessSession("agent-local-a", "default");
    const first = JSON.parse(
      readFileSync(path, "utf8"),
    ) as ProcessSessionRecord;
    expect(first).toMatchObject({
      pid: process.pid,
      agent_id: "agent-local-a",
      conversation_id: "default",
    });
    // the start of this process, which a later process with the same pid would not share
    expect(Math.abs(first.started_at - performance.timeOrigin)).toBeLessThan(1);

    recordProcessSession("agent-local-a", "local-conv-7");
    const second = JSON.parse(
      readFileSync(path, "utf8"),
    ) as ProcessSessionRecord;
    expect(second.conversation_id).toBe("local-conv-7");
    expect(second.started_at).toBe(first.started_at);
    // written whole: no temporary file is left beside it
    expect(readdirSync(join(configDir, "sessions"))).toEqual([
      `${process.pid}.json`,
    ]);
  });
});
