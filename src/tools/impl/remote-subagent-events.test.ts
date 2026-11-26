import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SubagentSnapshot } from "@/types/protocol_v2";
import { followRemoteSubagentEvents } from "./remote-subagent-events";
import { closeTaskProgressLog, openTaskProgressLog } from "./task-transcript";

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
const snapshot = (fields: Partial<SubagentSnapshot>) =>
  ({
    subagent_id: "worker-1",
    tool_calls: [{ id: "c1", name: "Bash", args: "{}" }],
    progress_texts: [{ id: "t1", at, text: "Suite 3 failed." }],
    ...fields,
  }) as SubagentSnapshot;

test("queued snapshots cannot erase consecutive event-read failures", async () => {
  const file = open();
  const pending: ReturnType<typeof Promise.withResolvers<never>>[] = [];
  const progress = followRemoteSubagentEvents(SUBAGENT, () => {
    const read = Promise.withResolvers<never>();
    pending.push(read);
    return read.promise;
  });
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  progress.recordSnapshot(snapshot({ event_seq: 1 }));
  await flush();
  progress.recordSnapshot(snapshot({ event_seq: 2 }));
  progress.recordSnapshot(snapshot({ event_seq: 3 }));
  pending[0]?.reject(new Error("request timed out"));
  await flush();
  expect(pending).toHaveLength(1);
  expect(readFileSync(file, "utf8")).toBe("");

  progress.recordSnapshot(snapshot({ event_seq: 3 }));
  await flush();
  expect(pending).toHaveLength(2);
  pending[1]?.reject(new Error("request timed out"));
  await flush();
  progress.recordSnapshot(snapshot({ event_seq: 4 }));
  expect(readFileSync(file, "utf8")).toBe(
    "[1970-01-01T00:00:00.000Z] tool: Bash {}\n" +
      `[${at}] text: Suite 3 failed.\n`,
  );
  await flush();
  expect(pending).toHaveLength(2);
});
