import { afterEach, expect, test } from "bun:test";
import {
  backgroundProcesses,
  backgroundTasks,
  shutdownBackgroundWork,
} from "./process_manager";

afterEach(() => {
  backgroundProcesses.clear();
  backgroundTasks.clear();
});

test("gracefully stops processes before forcing remaining work", async () => {
  const signals: Array<string | number | undefined> = [];
  const processState = {
    command: "sleep",
    exitCode: null,
    process: {
      kill(signal?: string | number) {
        signals.push(signal);
      },
    },
    status: "running" as const,
  };
  backgroundProcesses.set("process", processState);

  await shutdownBackgroundWork(1);

  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(processState).toMatchObject({
    completionNotificationSuppressed: true,
  });
});

test("aborts managed background tasks", async () => {
  const abortController = new AbortController();
  backgroundTasks.set("task", {
    abortController,
    description: "test",
    outputFile: "/tmp/test",
    startTime: new Date(),
    status: "running",
    subagentId: "test",
    subagentType: "test",
  });

  await shutdownBackgroundWork(1);

  expect(abortController.signal.aborted).toBe(true);
});
