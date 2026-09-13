import { describe, expect, mock, test } from "bun:test";
import type { ListenerRuntime } from "@/websocket/listener/types";
import { createMemfsSyncedTaskRunner } from "./memory-command-sync";

describe("listener memory command sync ordering", () => {
  test("waits for the in-flight MemFS checkout before reading a file", async () => {
    let finishSync: ((value: boolean) => void) | undefined;
    const sync = new Promise<boolean>((resolve) => {
      finishSync = resolve;
    });
    const runtime = {
      memfsSyncedAgents: new Map([["agent-test", sync]]),
    } as ListenerRuntime;
    const readFile = mock(() => {});
    let detachedTask: (() => Promise<void>) | undefined;

    const runMemoryTask = createMemfsSyncedTaskRunner(
      {
        type: "read_memory_file",
        agent_id: "agent-test",
      },
      runtime,
      (_commandName, task) => {
        detachedTask = task;
      },
    );
    runMemoryTask("read_memory_file", async () => readFile());

    expect(detachedTask).toBeDefined();

    const command = detachedTask?.();
    expect(readFile).not.toHaveBeenCalled();

    finishSync?.(true);
    await command;
    expect(readFile).toHaveBeenCalledTimes(1);
  });
});
