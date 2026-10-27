import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BackendMode,
  resolveBackendMode,
  setConfiguredBackendMode,
} from "@/backend/backend-mode";
import { __resetWorkflowExecutionsForTests } from "@/tools/workflow/execution-registry";
import type { SubagentSpawner } from "@/tools/workflow/types";
import {
  clearPendingMessages,
  type QueuedMessage,
  setMessageQueueAdder,
} from "@/utils/message-queue-bridge";
import { backgroundProcesses } from "./process_manager";
import { __setWorkflowSpawnerFactoryForTests, workflow } from "./workflow";

const META = `export const meta = { name: 'budget-tool', description: 'Budget tool test' }\n`;

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting");
    await Bun.sleep(10);
  }
}

describe("Workflow tool cost budget", () => {
  let home: string;
  let previousHome: string | undefined;
  let previousMode: BackendMode;
  let factoryCalls: number;
  let queued: QueuedMessage[];

  function installSpawner(costUsd: number) {
    const spawner: SubagentSpawner = async (request, _signal, hooks) => {
      hooks?.onUsage?.(100, costUsd);
      return {
        value: request.prompt,
        failed: false,
        totalTokens: 100,
        costUsd,
      };
    };
    __setWorkflowSpawnerFactoryForTests(async () => {
      factoryCalls += 1;
      return { spawner, cleanup: async () => {} };
    });
  }

  beforeEach(() => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "workflow-budget-test-"));
    process.env.HOME = home;
    previousMode = resolveBackendMode();
    setConfiguredBackendMode("api");
    factoryCalls = 0;
    queued = [];
    clearPendingMessages();
    setMessageQueueAdder((message) => queued.push(message));
  });

  afterEach(() => {
    backgroundProcesses.clear();
    __resetWorkflowExecutionsForTests();
    __setWorkflowSpawnerFactoryForTests(null);
    setMessageQueueAdder(null);
    clearPendingMessages();
    setConfiguredBackendMode(previousMode);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("rejects a non-positive budget before starting", async () => {
    installSpawner(0.1);
    for (const maxCostUsd of [0, -1, Number.NaN]) {
      const result = await workflow({ script: `${META}return 1`, maxCostUsd });
      expect(result).toEqual({
        status: "error",
        toolReturn: "maxCostUsd must be a positive number of US dollars.",
      });
    }
    expect(factoryCalls).toBe(0);
  });

  test("rejects a budget on the local backend, which reports no cost", async () => {
    installSpawner(0.1);
    setConfiguredBackendMode("local");
    const result = await workflow({
      script: `${META}return 1`,
      maxCostUsd: 5,
      wait: true,
    });
    expect(result.status).toBe("error");
    expect(result.toolReturn).toContain("requires Letta Cloud");
    expect(factoryCalls).toBe(0);
  });

  test("a foreground run stops at the budget and reports the spend", async () => {
    installSpawner(0.1);
    const result = await workflow({
      script: `${META}for (const p of ['a', 'b', 'c', 'd']) await agent(p)`,
      maxCostUsd: 0.25,
      wait: true,
    });
    expect(result.status).toBe("error");
    expect(result.toolReturn).toBe(
      "Workflow failed: Workflow cost budget of $0.2500 reached. $0.3000 spent of $0.2500.",
    );
  });

  test("a completed background run carries its cost in the notification", async () => {
    installSpawner(0.1);
    const launched = await workflow({
      script: `${META}await agent('a'); return await agent('b')`,
      maxCostUsd: 5,
    });
    expect(launched.status).toBe("success");
    await waitFor(() => queued.length > 0);
    const text = queued[0]?.text ?? "";
    expect(text).toContain("2 agents · 200 tokens · $0.2000");
    expect(text).toContain('"totalCostUsd": 0.2');
  });
});
