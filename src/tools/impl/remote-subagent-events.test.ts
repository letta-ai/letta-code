import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SubagentSnapshot } from "@/types/protocol_v2";
import type { SubagentEventRecord } from "@/types/subagent-protocol";
import { followRemoteSubagentEvents } from "./remote-subagent-events";
import {
  closeTaskProgressLog,
  openTaskProgressLog,
  taskEventsFileFor,
} from "./task-transcript";

const SUBAGENT = "remote-events-test";
let dir = "";

afterEach(() => {
  closeTaskProgressLog(SUBAGENT);
  rmSync(dir, { recursive: true, force: true });
});

function open(): string {
  dir = mkdtempSync(join(tmpdir(), "remote-events-"));
  const file = join(dir, "task.log");
  writeFileSync(file, "");
  openTaskProgressLog(SUBAGENT, file, undefined, { now: () => new Date(0) });
  return file;
}

const at = "2026-11-01T10:00:00.000Z";
const output = `FAIL test_parse_hours\n${"x".repeat(10_000)}`;
const remote: SubagentEventRecord[] = [
  { seq: 1, at, type: "tool_call", id: "c1", name: "Bash", input: {} },
  {
    seq: 2,
    at,
    type: "tool_result",
    tool_call_id: "c1",
    name: "Bash",
    is_error: true,
    output,
  },
  { seq: 3, at, type: "text", text: "Suite 3 failed." },
];
const snapshot = (fields: Partial<SubagentSnapshot>) =>
  ({
    subagent_id: "worker-1",
    tool_calls: [{ id: "c1", name: "Bash", args: "{}" }],
    progress_texts: [{ id: "t1", at, text: "Suite 3 failed." }],
    ...fields,
  }) as SubagentSnapshot;

test("reads each announced event once, in full, a page at a time", async () => {
  const file = open();
  const reads: number[] = [];
  const progress = followRemoteSubagentEvents(SUBAGENT, async (afterSeq) => {
    reads.push(afterSeq);
    const events = remote.filter((e) => e.seq > afterSeq).slice(0, 2);
    const next = events.at(-1)?.seq ?? afterSeq;
    return {
      type: "read_subagent_events_response",
      request_id: "r",
      runtime: { agent_id: "a", conversation_id: "c" },
      subagent_id: "worker-1",
      success: true,
      events,
      next_seq: next,
      has_more: next < 3,
      missed: 0,
    };
  });
  progress.recordSnapshot(snapshot({ event_seq: 2 }));
  // The snapshot lists name the same call and text; they are not repeated.
  await progress.finish(snapshot({ event_seq: 3 }));

  expect(reads).toEqual([0, 2]);
  const events = readFileSync(taskEventsFileFor(file), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(events.map((e) => e.type)).toEqual([
    "tool_call",
    "tool_result",
    "text",
  ]);
  expect(events[1].output).toBe(output);
  expect(readFileSync(file, "utf8")).toContain(
    "result: Bash error, 9.8 KB: FAIL test_parse_hours",
  );
});

test("falls back to the snapshot lists from an older computer or failed reads", async () => {
  const file = open();
  // An older computer announces no event_seq.
  followRemoteSubagentEvents(SUBAGENT, async () => {
    throw new Error("unreachable");
  }).recordSnapshot(snapshot({}));
  const failing = followRemoteSubagentEvents(SUBAGENT, async () => {
    throw new Error("unknown command");
  });
  await failing.finish(snapshot({ event_seq: 3 }));
  expect(readFileSync(file, "utf8")).toBe(
    "[1970-01-01T00:00:00.000Z] tool: Bash {}\n" +
      `[${at}] text: Suite 3 failed.\n`,
  );
});
