import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedRecord } from "@/agent/trajectories/types";
import { isNormalizedRecordArray } from "@/agent/trajectories/types";
import { createTranscriptFileSource } from "./transcript-file";

const VALID_RECORDS: NormalizedRecord[] = [
  {
    role: "meta",
    source: "claude_code",
    cwd: "/repo/app",
    model: "claude-opus-4",
  },
  { role: "user", content: "Fix it", timestamp: "2026-07-01T10:00:00.000Z" },
  {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "t1", name: "Bash", args: '{"command":"ls"}' }],
    timestamp: "2026-07-01T10:00:05.000Z",
  },
  {
    role: "tool",
    tool_call_id: "t1",
    content: "ok",
    timestamp: "2026-07-01T10:00:06.000Z",
  },
  {
    role: "assistant",
    content: "Done.",
    timestamp: "2026-07-01T10:00:10.000Z",
  },
];

describe("createTranscriptFileSource", () => {
  const source = createTranscriptFileSource();
  let dir: string;
  let validPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "transcripts-"));
    validPath = join(dir, "session-one.json");
    writeFileSync(validPath, JSON.stringify(VALID_RECORDS));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("requires a locator and an existing path", async () => {
    await expect(source.discover()).rejects.toThrow("no default local store");
    await expect(source.discover(join(dir, "missing"))).rejects.toThrow(
      "No such transcript path",
    );
  });

  test("discovers a single file", async () => {
    const sessions = await source.discover(validPath);
    expect(sessions).toHaveLength(1);
    const session = sessions[0];
    expect(session?.harness).toBe("transcript");
    expect(session?.sessionId).toBe("session-one");
    expect(session?.cwd).toBe("/repo/app");
    expect(session?.recordCount).toBe(4); // meta excluded
    expect(session?.startTime).toBe("2026-07-01T10:00:00.000Z");
    expect(session?.endTime).toBe("2026-07-01T10:00:10.000Z");
    expect(session?.estTokens).toBeGreaterThan(0);
  });

  test("scans a directory tree, skipping non-transcript files", async () => {
    const nested = join(dir, "claude_code");
    mkdirSync(nested);
    writeFileSync(
      join(nested, "session-two.json"),
      JSON.stringify(VALID_RECORDS),
    );
    writeFileSync(join(dir, "broken.json"), "{{{ not json");
    writeFileSync(join(dir, "wrong-shape.json"), JSON.stringify({ foo: 1 }));
    writeFileSync(join(dir, "empty-array.json"), "[]");
    writeFileSync(
      join(dir, "meta-only.json"),
      JSON.stringify([{ role: "meta", source: "codex" }]),
    );
    writeFileSync(
      join(dir, "no-timestamps.json"),
      JSON.stringify([
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ]),
    );
    writeFileSync(join(dir, "notes.txt"), "not a transcript");

    const sessions = await source.discover(dir);
    expect(sessions.map((s) => s.sessionId).sort()).toEqual([
      "session-one",
      "session-two",
    ]);
  });

  test("normalize returns the records unchanged", async () => {
    const sessions = await source.discover(validPath);
    const session = sessions[0];
    if (!session) throw new Error("expected a session");
    const { records } = await source.normalize(session);
    expect(records).toEqual(VALID_RECORDS);
  });
});

describe("isNormalizedRecordArray", () => {
  test("accepts valid record arrays", () => {
    expect(isNormalizedRecordArray(VALID_RECORDS)).toBe(true);
    expect(isNormalizedRecordArray([])).toBe(true);
  });

  test("rejects non-arrays and malformed records", () => {
    expect(isNormalizedRecordArray(null)).toBe(false);
    expect(isNormalizedRecordArray({ items: [] })).toBe(false);
    expect(isNormalizedRecordArray([{ role: "wizard" }])).toBe(false);
    expect(isNormalizedRecordArray([{ role: "user", content: 42 }])).toBe(
      false,
    );
    expect(isNormalizedRecordArray([{ role: "user", timestamp: 42 }])).toBe(
      false,
    );
    expect(
      isNormalizedRecordArray([
        { role: "assistant", tool_calls: [{ id: "a", name: "b" }] },
      ]),
    ).toBe(false); // args missing
  });
});
