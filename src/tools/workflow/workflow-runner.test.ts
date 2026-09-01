import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SubagentSpawner, WorkflowProgressEvent } from "./types.ts";
import { runWorkflow } from "./workflow-runner.ts";

function tempRunsDir(): string {
  return mkdtempSync(join(tmpdir(), "lc-workflow-test-"));
}

function withMeta(body: string): string {
  return `export const meta = { name: 'test-flow', description: 'test' }\n${body}`;
}

const echoSpawner: SubagentSpawner = async (request) => ({
  value: request.options.schema
    ? { echoed: request.prompt }
    : `echo:${request.prompt}`,
  failed: false,
  costUsd: 0.01,
});

describe("runWorkflow", () => {
  test("agent() returns the subagent's text", async () => {
    const run = await runWorkflow(echoSpawner, {
      script: withMeta(`return await agent('hello')`),
      runsDir: tempRunsDir(),
    });
    expect(run.result).toBe("echo:hello");
    expect(run.agentsSpawned).toBe(1);
    expect(run.totalCostUsd).toBeCloseTo(0.01);
  });

  test("agent() with schema returns the structured object", async () => {
    const run = await runWorkflow(echoSpawner, {
      script: withMeta(
        `return await agent('hi', {schema: {type: 'object', properties: {echoed: {type: 'string'}}}})`,
      ),
      runsDir: tempRunsDir(),
    });
    expect(run.result).toEqual({ echoed: "hi" });
  });

  test("failed subagents resolve to null", async () => {
    const failing: SubagentSpawner = async () => ({
      value: null,
      failed: true,
      error: "boom",
    });
    const run = await runWorkflow(failing, {
      script:
        withMeta(`const r = await parallel([() => agent('a'), () => agent('b')]);
return r.filter(Boolean).length;`),
      runsDir: tempRunsDir(),
    });
    expect(run.result).toBe(0);
  });

  test("pipeline() has no barrier between stages", async () => {
    // Item "slow" blocks in stage 1 until item "fast" has finished stage 2.
    let fastDone: () => void = () => {};
    const fastFinished = new Promise<void>((resolve) => {
      fastDone = resolve;
    });
    const spawner: SubagentSpawner = async (request) => {
      if (request.prompt === "s1:slow") await fastFinished;
      if (request.prompt === "s2:fast") fastDone();
      return { value: request.prompt, failed: false };
    };
    const run = await runWorkflow(spawner, {
      script: withMeta(`return await pipeline(
  ['fast', 'slow'],
  (item) => agent('s1:' + item),
  (prev, item) => agent('s2:' + item),
)`),
      runsDir: tempRunsDir(),
    });
    // If stages were barriers, s2:fast would wait on s1:slow -> deadlock.
    expect(run.result).toEqual(["s2:fast", "s2:slow"]);
  });

  test("pipeline() stage throw drops the item to null and skips later stages", async () => {
    const run = await runWorkflow(echoSpawner, {
      script: withMeta(`return await pipeline(
  [1, 2],
  (item) => { if (item === 1) throw new Error('nope'); return item * 10; },
  (prev) => prev + 1,
)`),
      runsDir: tempRunsDir(),
    });
    expect(run.result).toEqual([null, 21]);
  });

  test("budget ceiling makes agent() throw once exhausted", async () => {
    const costly: SubagentSpawner = async () => ({
      value: "x",
      failed: false,
      costUsd: 0.6,
    });
    const run = runWorkflow(costly, {
      script: withMeta(
        `await agent('one');\nawait agent('two');\nreturn 'finished'`,
      ),
      budgetUsd: 0.5,
      runsDir: tempRunsDir(),
    });
    await expect(run).rejects.toThrow(/Budget/);
  });

  test("Date.now and Math.random are blocked inside scripts", async () => {
    const dateRun = runWorkflow(echoSpawner, {
      script: withMeta(`return Date.now()`),
      runsDir: tempRunsDir(),
    });
    await expect(dateRun).rejects.toThrow(/Date.now/);
    const randomRun = runWorkflow(echoSpawner, {
      script: withMeta(`return Math.random()`),
      runsDir: tempRunsDir(),
    });
    await expect(randomRun).rejects.toThrow(/Math.random/);
  });

  test("new Date(explicit) still works inside scripts", async () => {
    const run = await runWorkflow(echoSpawner, {
      script: withMeta(`return new Date(0).toISOString()`),
      runsDir: tempRunsDir(),
    });
    expect(run.result).toBe("1970-01-01T00:00:00.000Z");
  });

  test("phase() and log() emit progress events", async () => {
    const events: WorkflowProgressEvent[] = [];
    await runWorkflow(echoSpawner, {
      script: withMeta(
        `phase('Scan');\nlog('starting');\nreturn await agent('a')`,
      ),
      runsDir: tempRunsDir(),
      onProgress: (event) => events.push(event),
    });
    expect(events.some((e) => e.kind === "phase" && e.title === "Scan")).toBe(
      true,
    );
    expect(
      events.some((e) => e.kind === "log" && e.message === "starting"),
    ).toBe(true);
    const agentEvents = events.filter((e) => e.kind === "agent");
    expect(agentEvents.at(-1)).toMatchObject({ status: "done", phase: "Scan" });
  });

  test("resume replays journaled outcomes without respawning", async () => {
    const runsDir = tempRunsDir();
    let spawns = 0;
    const counting: SubagentSpawner = async (request) => {
      spawns++;
      return { value: `run:${request.prompt}`, failed: false };
    };
    const script = withMeta(
      `return await parallel([() => agent('a'), () => agent('b')])`,
    );
    const first = await runWorkflow(counting, { script, runsDir });
    expect(spawns).toBe(2);

    const second = await runWorkflow(counting, {
      script,
      runsDir,
      resumeFromRunId: first.runId,
    });
    expect(spawns).toBe(2);
    expect(second.cacheHits).toBe(2);
    expect(second.result).toEqual(["run:a", "run:b"]);
  });

  test("resume re-runs only edited calls", async () => {
    const runsDir = tempRunsDir();
    const spawnedPrompts: string[] = [];
    const tracking: SubagentSpawner = async (request) => {
      spawnedPrompts.push(request.prompt);
      return { value: request.prompt, failed: false };
    };
    const first = await runWorkflow(tracking, {
      script: withMeta(
        `return await parallel([() => agent('a'), () => agent('b')])`,
      ),
      runsDir,
    });
    spawnedPrompts.length = 0;
    const second = await runWorkflow(tracking, {
      script: withMeta(
        `return await parallel([() => agent('a'), () => agent('CHANGED')])`,
      ),
      runsDir,
      resumeFromRunId: first.runId,
    });
    expect(spawnedPrompts).toEqual(["CHANGED"]);
    expect(second.result).toEqual(["a", "CHANGED"]);
  });

  test("lifetime agent cap throws", async () => {
    const run = runWorkflow(echoSpawner, {
      script: withMeta(
        `for (let i = 0; i < 10; i++) await agent('call ' + i);`,
      ),
      maxTotalAgents: 3,
      runsDir: tempRunsDir(),
    });
    await expect(run).rejects.toThrow(/cap/);
  });

  test("workflow() runs a child script sharing budget and journal", async () => {
    const runsDir = tempRunsDir();
    const childPath = join(runsDir, "child.workflow.js");
    writeFileSync(
      childPath,
      `export const meta = { name: 'child-flow', description: 'child' }\nreturn await agent('from-child:' + args.tag)`,
    );
    const run = await runWorkflow(echoSpawner, {
      script: withMeta(
        `const child = await workflow(${JSON.stringify(childPath)}, {tag: 'x'});\nreturn child;`,
      ),
      runsDir,
    });
    expect(run.result).toBe("echo:from-child:x");
    expect(run.agentsSpawned).toBe(1);
    expect(run.totalCostUsd).toBeCloseTo(0.01);
  });

  test("workflow() nesting is one level only", async () => {
    const runsDir = tempRunsDir();
    const grandchildPath = join(runsDir, "grandchild.workflow.js");
    writeFileSync(
      grandchildPath,
      `export const meta = { name: 'grandchild-flow', description: 'g' }\nreturn 1;`,
    );
    const childPath = join(runsDir, "nested-child.workflow.js");
    writeFileSync(
      childPath,
      `export const meta = { name: 'nested-child-flow', description: 'c' }\nreturn await workflow(${JSON.stringify(grandchildPath)});`,
    );
    const run = runWorkflow(echoSpawner, {
      script: withMeta(`return await workflow(${JSON.stringify(childPath)});`),
      runsDir,
    });
    await expect(run).rejects.toThrow(/one level only/);
  });

  test("scripts with TypeScript annotations fail to parse with a clear error", async () => {
    const run = runWorkflow(echoSpawner, {
      script: withMeta(`const items: string[] = [];\nreturn items;`),
      runsDir: tempRunsDir(),
    });
    await expect(run).rejects.toThrow(/failed to parse/);
  });
});
