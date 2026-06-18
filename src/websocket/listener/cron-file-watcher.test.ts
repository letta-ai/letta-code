import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type CronFileWatcherState,
  startCronFileWatcher,
  stopCronFileWatcher,
} from "@/websocket/listener/cron-file-watcher";
import type { LocalTransport } from "@/websocket/listener/transport";

const TEST_DIR = path.join(import.meta.dir, "__cron_watcher_test_tmp__");
const CRON_PATH = path.join(TEST_DIR, "crons.json");

const origHome = process.env.LETTA_HOME;

function makeRecordingTransport(): {
  transport: LocalTransport;
  sent: unknown[];
} {
  const sent: unknown[] = [];
  const transport: LocalTransport = {
    kind: "local",
    bufferedAmount: 0,
    isOpen: () => true,
    send: (data: string) => {
      sent.push(JSON.parse(data));
    },
  };
  return { transport, sent };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("cron-file-watcher", () => {
  let watcher: CronFileWatcherState | null = null;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.LETTA_HOME = TEST_DIR;
  });

  afterEach(() => {
    if (watcher) {
      stopCronFileWatcher(watcher);
      watcher = null;
    }
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    if (origHome) process.env.LETTA_HOME = origHome;
    else delete process.env.LETTA_HOME;
  });

  test("broadcasts crons_updated when crons.json changes on disk", async () => {
    const { transport, sent } = makeRecordingTransport();
    watcher = startCronFileWatcher({ transport });

    // Give the async watch loop a moment to attach.
    await sleep(100);

    writeFileSync(
      CRON_PATH,
      JSON.stringify({ version: 1, scheduler_owner: null, tasks: [] }),
    );

    // Wait past the debounce window + fs.watch latency.
    await sleep(600);

    expect(sent.length).toBeGreaterThanOrEqual(1);
    const evt = sent[0] as { type: string; agent_id?: string };
    expect(evt.type).toBe("crons_updated");
    // Broadcast is scope-less so every open Schedules view refetches.
    expect(evt.agent_id).toBeUndefined();
  });

  test("debounces rapid writes into a single broadcast", async () => {
    const { transport, sent } = makeRecordingTransport();
    watcher = startCronFileWatcher({ transport });
    await sleep(100);

    for (let i = 0; i < 5; i++) {
      writeFileSync(
        CRON_PATH,
        JSON.stringify({
          version: 1,
          scheduler_owner: null,
          tasks: [{ n: i }],
        }),
      );
      await sleep(20);
    }

    await sleep(600);

    // All writes land within the debounce window → one coalesced broadcast.
    expect(sent.length).toBe(1);
    expect((sent[0] as { type: string }).type).toBe("crons_updated");
  });

  test("stops broadcasting after the watcher is stopped", async () => {
    const { transport, sent } = makeRecordingTransport();
    watcher = startCronFileWatcher({ transport });
    await sleep(100);

    stopCronFileWatcher(watcher);
    watcher = null;
    await sleep(50);

    writeFileSync(
      CRON_PATH,
      JSON.stringify({ version: 1, scheduler_owner: null, tasks: [] }),
    );
    await sleep(600);

    expect(sent.length).toBe(0);
  });
});
