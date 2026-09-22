import { afterEach, expect, test } from "bun:test";
import { once } from "node:events";
import { spawnSubagentProcess } from "@/agent/subagents/subagent-process";
import {
  cancelBackgroundMemoryTasks,
  shutdownBackgroundMemoryTasks,
} from "./memory-task-lifecycle";
import { backgroundTasks } from "./process_manager";

afterEach(() => backgroundTasks.clear());

test("shutdown drains memory tasks from every conversation but does not wait for unrelated agents", async () => {
  const completed: string[] = [];
  for (const [id, subagentType] of [
    ["first", "memory"],
    ["switched", "memory"],
    ["other", "general-purpose"],
  ] as const) {
    backgroundTasks.set(id, {
      description: "test",
      subagentType: subagentType,
      subagentId: id,
      status: "running",
      output: [],
      outputFile: "",
      startTime: new Date(),
      runtimeScope: { agentId: "agent-parent", conversationId: id },
      completion:
        subagentType === "memory"
          ? Bun.sleep(20).then(() => {
              completed.push(id);
            })
          : new Promise(() => {}),
    });
  }
  await shutdownBackgroundMemoryTasks(0);
  expect(completed.sort()).toEqual(["first", "switched"]);
});

test.skipIf(process.platform === "win32")(
  "error shutdown waits for actual child teardown before returning",
  async () => {
    const controller = new AbortController();
    const running = spawnSubagentProcess(
      process.execPath,
      [
        "-e",
        'process.on("SIGINT", () => setTimeout(() => process.exit(0), 100)); console.log("ready"); setInterval(() => {}, 1000);',
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        signal: controller.signal,
        forceKillGraceMs: 200,
      },
    );
    try {
      await once(running.process.stdout, "data");
      let settled = false;
      backgroundTasks.set("memory", {
        description: "test",
        subagentType: "memory",
        subagentId: "memory",
        status: "running",
        output: [],
        outputFile: "",
        startTime: new Date(),
        abortController: controller,
        completion: running.completion.then(() => {
          settled = true;
        }),
      });
      await shutdownBackgroundMemoryTasks(1);
      expect(controller.signal.aborted).toBe(true);
      expect(settled).toBe(true);
      const pid = running.process.pid;
      if (!pid) throw new Error("No child PID");
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      controller.abort();
      await running.completion;
    }
  },
);

test("interactive exit cancels memory tasks instead of waiting for them", async () => {
  const controller = new AbortController();
  let settled = false;
  backgroundTasks.set("memory", {
    description: "test",
    subagentType: "memory",
    subagentId: "memory",
    status: "running",
    output: [],
    outputFile: "",
    startTime: new Date(),
    runtimeScope: { agentId: "agent-parent", conversationId: "conv" },
    abortController: controller,
    // Mirrors a worker whose lifecycle only settles once its signal fires.
    completion: new Promise<void>((resolve) => {
      controller.signal.addEventListener("abort", () => {
        settled = true;
        resolve();
      });
    }),
  });
  await cancelBackgroundMemoryTasks();
  expect(controller.signal.aborted).toBe(true);
  expect(settled).toBe(true);
});
