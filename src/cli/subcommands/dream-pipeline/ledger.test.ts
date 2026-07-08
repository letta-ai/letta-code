import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "@/agent/trajectories/types";
import { TRANSCRIPT_ROOT_ENV } from "@/utils/transcript-paths";
import {
  filterSessionsAgainstLedger,
  readDreamLedger,
  recordDreamedSessions,
} from "./ledger";

const AGENT_ID = "agent-ledger-test";

function session(
  id: string,
  mtimeMs: number,
  harness = "claude",
): DiscoveredSession {
  return {
    harness,
    sessionId: id,
    path: `/tmp/${id}.json`,
    startTime: "2026-03-01T00:00:00Z",
    endTime: "2026-03-01T01:00:00Z",
    estTokens: 100,
    recordCount: 5,
    mtimeMs,
  };
}

describe("dream ledger", () => {
  let tempRoot: string;
  let previousRoot: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "dream-ledger-"));
    previousRoot = process.env[TRANSCRIPT_ROOT_ENV];
    process.env[TRANSCRIPT_ROOT_ENV] = tempRoot;
  });

  afterEach(() => {
    if (previousRoot === undefined) {
      delete process.env[TRANSCRIPT_ROOT_ENV];
    } else {
      process.env[TRANSCRIPT_ROOT_ENV] = previousRoot;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("empty ledger filters nothing", async () => {
    const ledger = await readDreamLedger(AGENT_ID);
    const sessions = [session("a", 100), session("b", 200)];
    const { fresh, skipped } = filterSessionsAgainstLedger(ledger, sessions);
    expect(fresh.length).toBe(2);
    expect(skipped.length).toBe(0);
  });

  test("recorded sessions are skipped on the next run", async () => {
    await recordDreamedSessions(AGENT_ID, [session("a", 100)], "run-1");
    const ledger = await readDreamLedger(AGENT_ID);
    const { fresh, skipped } = filterSessionsAgainstLedger(ledger, [
      session("a", 100),
      session("b", 50),
    ]);
    expect(fresh.map((s) => s.sessionId)).toEqual(["b"]);
    expect(skipped.map((s) => s.sessionId)).toEqual(["a"]);
    expect(ledger.sessions["claude:a"]?.runId).toBe("run-1");
  });

  test("a session that changed since reflection is re-ingested", async () => {
    await recordDreamedSessions(AGENT_ID, [session("a", 100)], "run-1");
    const ledger = await readDreamLedger(AGENT_ID);
    const { fresh } = filterSessionsAgainstLedger(ledger, [session("a", 250)]);
    expect(fresh.map((s) => s.sessionId)).toEqual(["a"]);
  });

  test("sessions from different harnesses do not collide", async () => {
    await recordDreamedSessions(
      AGENT_ID,
      [session("a", 100, "codex")],
      "run-1",
    );
    const ledger = await readDreamLedger(AGENT_ID);
    const { fresh, skipped } = filterSessionsAgainstLedger(ledger, [
      session("a", 100, "claude"),
      session("a", 100, "codex"),
    ]);
    expect(fresh.map((s) => s.harness)).toEqual(["claude"]);
    expect(skipped.map((s) => s.harness)).toEqual(["codex"]);
  });
});
