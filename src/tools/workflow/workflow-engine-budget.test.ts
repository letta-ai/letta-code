import { describe, expect, test } from "bun:test";
import type { SubagentSpawner } from "./types.ts";
import { executeWorkflow } from "./workflow-engine.ts";

const META = `export const meta = { name: 'budget', description: 'budget test' }\n`;

/** Each agent reports `costUsd` live and in its outcome. */
function pricedSpawner(
  costUsd: number,
  spawned: string[] = [],
): SubagentSpawner {
  return async (request, _signal, hooks) => {
    spawned.push(request.prompt);
    hooks?.onUsage?.(100, costUsd);
    return { value: request.prompt, failed: false, totalTokens: 100, costUsd };
  };
}

describe("executeWorkflow cost budget", () => {
  test("reports total cost and does not double-count live and final usage", async () => {
    const run = await executeWorkflow(
      async (request, _signal, hooks) => {
        hooks?.onUsage?.(50, 0.1);
        hooks?.onUsage?.(100, 0.2);
        return { value: request.prompt, failed: false, costUsd: 0.2 };
      },
      { script: `${META}await agent('a'); return await agent('b')` },
    );
    expect(run.totalCostUsd).toBeCloseTo(0.4);
  });

  test("stops the run once spend reaches the budget", async () => {
    const spawned: string[] = [];
    const run = executeWorkflow(pricedSpawner(0.1, spawned), {
      script: `${META}for (const p of ['a', 'b', 'c', 'd']) await agent(p)`,
      maxCostUsd: 0.25,
    });
    await expect(run).rejects.toMatchObject({
      code: "budget_exceeded",
      message: expect.stringContaining("$0.3000 spent of $0.2500"),
    });
    expect(spawned).toEqual(["a", "b", "c"]);
  });

  test("a script that catches the budget error still ends as a budget stop", async () => {
    const spawned: string[] = [];
    const run = executeWorkflow(pricedSpawner(1, spawned), {
      script: `${META}
for (const p of ['a', 'b']) { try { await agent(p) } catch {} }
return 'finished anyway'`,
      maxCostUsd: 1,
    });
    await expect(run).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(spawned).toEqual(["a"]);
  });

  test("interrupts running subagents and counts what they spent", async () => {
    let slowSawAbort = false;
    const run = executeWorkflow(
      async (request, signal, hooks) => {
        if (request.prompt === "expensive") {
          hooks?.onUsage?.(1_000, 1.5);
          return { value: "x", failed: false, costUsd: 1.5 };
        }
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        slowSawAbort = true;
        return {
          value: null,
          failed: true,
          error: "interrupted",
          costUsd: 0.05,
        };
      },
      {
        script: `${META}return await parallel([() => agent('slow'), () => agent('expensive')])`,
        maxCostUsd: 1,
      },
    );
    await expect(run).rejects.toMatchObject({
      code: "budget_exceeded",
      message: expect.stringContaining("$1.55 spent of $1.00"),
    });
    expect(slowSawAbort).toBe(true);
  });

  test("stops when a budgeted run sees usage without a cost estimate", async () => {
    const unpriced: SubagentSpawner = async (_request, _signal, hooks) => {
      hooks?.onUsage?.(100, null);
      return { value: "ok", failed: false, costUsd: null };
    };
    await expect(
      executeWorkflow(unpriced, {
        script: `${META}return await agent('a')`,
        maxCostUsd: 5,
      }),
    ).rejects.toMatchObject({
      code: "cost_unavailable",
      message: expect.stringContaining('agent "a"'),
    });

    const unbudgeted = await executeWorkflow(unpriced, {
      script: `${META}return await agent('a')`,
    });
    expect(unbudgeted.result).toBe("ok");
    expect(unbudgeted.totalCostUsd).toBeNull();
  });

  test("exposes live spend to the script through budget", async () => {
    const script = `${META}await agent('a')
return [budget.limit, budget.spent, budget.remaining]`;
    const budgeted = await executeWorkflow(pricedSpawner(0.25), {
      script,
      maxCostUsd: 1,
    });
    expect(budgeted.result).toEqual([1, 0.25, 0.75]);
    const unbudgeted = await executeWorkflow(pricedSpawner(0.25), { script });
    expect(unbudgeted.result).toEqual([null, 0.25, null]);
  });
});
