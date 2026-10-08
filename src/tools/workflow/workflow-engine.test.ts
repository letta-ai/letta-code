import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  SubagentOutcome,
  SubagentRequest,
  SubagentSpawner,
  WorkflowProgressEvent,
} from "./types.ts";
import { executeWorkflow } from "./workflow-engine.ts";

const META = `export const meta = { name: 'test', description: 'engine test' }\n`;

function echoSpawner(): SubagentSpawner {
  return async (request) => ({
    value: `echo:${request.prompt}`,
    failed: false,
  });
}

describe("executeWorkflow", () => {
  test("runs the script body with hooks and returns its value", async () => {
    const seen: SubagentRequest[] = [];
    const events: WorkflowProgressEvent[] = [];
    const run = await executeWorkflow(
      async (request) => {
        seen.push(request);
        return { value: `echo:${request.prompt}`, failed: false };
      },
      {
        script: `${META}
phase('Work')
log('hello ' + args.who)
const a = await agent('one', { label: 'first', json: false })
const b = await agent('two', { phase: 'Other' })
return [a, b]`,
        args: { who: "world" },
        onProgress: (event) => events.push(event),
      },
    );
    expect(run.result).toEqual(["echo:one", "echo:two"]);
    expect(run.agentsSpawned).toBe(2);
    expect(run.meta.name).toBe("test");
    expect(seen.map((r) => r.callIndex)).toEqual([0, 1]);
    expect(seen[0]?.options).toEqual({ label: "first", json: false });
    expect(events).toContainEqual({ kind: "phase", title: "Work" });
    expect(events).toContainEqual({ kind: "log", message: "hello world" });
    const agentEvents = events.filter((e) => e.kind === "agent");
    expect(agentEvents.map((e) => [e.label, e.phase, e.status])).toEqual([
      ["first", "Work", "queued"],
      ["first", "Work", "running"],
      ["first", "Work", "done"],
      ["two", "Other", "queued"],
      ["two", "Other", "running"],
      ["two", "Other", "done"],
    ]);
  });

  test("relays live usage as running events with cumulative tokens", async () => {
    const events: WorkflowProgressEvent[] = [];
    const spawner: SubagentSpawner = async (_request, _signal, hooks) => {
      hooks?.onUsage?.(500);
      hooks?.onUsage?.(1_200);
      return { value: "ok", failed: false, totalTokens: 1_200 };
    };
    await executeWorkflow(spawner, {
      script: `${META}phase('P'); await agent('x', { label: 'L' })`,
      onProgress: (event) => events.push(event),
    });
    const agentEvents = events.filter((e) => e.kind === "agent");
    expect(agentEvents.map((e) => [e.status, e.totalTokens])).toEqual([
      ["queued", undefined],
      ["running", undefined],
      ["running", 500],
      ["running", 1_200],
      ["done", 1_200],
    ]);
    expect(agentEvents.every((e) => e.label === "L" && e.phase === "P")).toBe(
      true,
    );
  });

  test("a failed subagent rejects with its identity and reports the error", async () => {
    const events: WorkflowProgressEvent[] = [];
    const pending = executeWorkflow(
      async () => ({
        value: null,
        failed: true,
        error: "boom",
        conversationId: "conv-failed-worker",
      }),
      {
        script: `${META}return await agent('x', { label: 'reader' })`,
        onProgress: (event) => events.push(event),
      },
    );
    await expect(pending).rejects.toMatchObject({
      message: 'Workflow agent "reader" (conv-failed-worker) failed: boom',
      callIndex: 0,
      conversationId: "conv-failed-worker",
    });
    expect(events.at(-1)).toMatchObject({ status: "error", detail: "boom" });
  });

  test("pipeline has no barrier between stages", async () => {
    const order: string[] = [];
    const gates = new Map<string, () => void>();
    const spawner: SubagentSpawner = async (request) => {
      order.push(`start:${request.prompt}`);
      await new Promise<void>((resolve) => gates.set(request.prompt, resolve));
      order.push(`end:${request.prompt}`);
      return { value: request.prompt, failed: false };
    };
    const pending = executeWorkflow(spawner, {
      script: `${META}
return await pipeline(['a', 'b'],
  (item) => agent('s1:' + item),
  (prev, item, index) => agent('s2:' + prev + ':' + index))`,
    });
    await Bun.sleep(20);
    // Both stage-1 calls are in flight; finishing only 'a' lets its stage 2
    // start while 'b' is still in stage 1.
    gates.get("s1:a")?.();
    await Bun.sleep(20);
    expect(order).toEqual([
      "start:s1:a",
      "start:s1:b",
      "end:s1:a",
      "start:s2:s1:a:0",
    ]);
    gates.get("s1:b")?.();
    await Bun.sleep(20);
    gates.get("s2:s1:a:0")?.();
    gates.get("s2:s1:b:1")?.();
    const run = await pending;
    expect(run.result).toEqual(["s2:s1:a:0", "s2:s1:b:1"]);
  });

  test.each([
    "return await pipeline([1, 2], n => { if (n === 2) throw new Error('no'); return n })",
    "return await parallel([() => agent('ok'), () => { throw new Error('no') }])",
  ])("helpers propagate callback errors: %s", async (script) => {
    await expect(
      executeWorkflow(echoSpawner(), { script: META + script }),
    ).rejects.toThrow("no");
  });

  test.each([
    "return await parallel([() => agent('bad'), () => agent('good')])",
    "return await pipeline(['bad', 'good'], x => agent(x), x => agent('next:' + x))",
  ])(
    "helpers report worker failure after siblings finish: %s",
    async (script) => {
      const seen: string[] = [];
      const pending = executeWorkflow(
        async (request) => {
          if (request.prompt === "bad") {
            return { value: null, failed: true, error: "worker failed" };
          }
          await Bun.sleep(5);
          seen.push(request.prompt);
          return { value: request.prompt, failed: false };
        },
        { script: META + script, maxConcurrent: 1 },
      );
      await expect(pending).rejects.toThrow("worker failed");
      expect(seen).toContain("good");
      if (script.includes("pipeline")) expect(seen).toContain("next:good");
      expect(seen).not.toContain("next:null");
    },
  );

  test("explicit catches allow best-effort work and preserve successful nulls", async () => {
    const run = await executeWorkflow(
      async (request) => ({
        value: null,
        failed: request.prompt === "bad",
        error: request.prompt === "bad" ? "boom" : undefined,
      }),
      {
        script: `${META}
return await parallel(['bad', 'empty'].map(prompt => async () => {
  try { return { value: await agent(prompt) } }
  catch (error) { return { error: error.message } }
}))`,
      },
    );
    expect(run.result).toEqual([
      { error: 'Workflow agent "bad" failed: boom' },
      { value: null },
    ]);
  });

  test("caps concurrency and total agents", async () => {
    let running = 0;
    let peak = 0;
    const spawner: SubagentSpawner = async (request) => {
      running++;
      peak = Math.max(peak, running);
      await Bun.sleep(5);
      running--;
      return { value: request.prompt, failed: false };
    };
    const run = await executeWorkflow(spawner, {
      script: `${META}
const done = await parallel(Array.from({length: 6}, (_, i) => () => agent('p' + i)))
let capped = null
try { await agent('too many') } catch (e) { capped = e.message }
return { done: done.length, capped }`,
      maxConcurrent: 2,
      maxTotalAgents: 6,
    });
    expect(peak).toBe(2);
    expect(run.result).toEqual({
      done: 6,
      capped: "Lifetime agent cap of 6 reached.",
    });
  });

  test("caps decisions independently without calling the provider", async () => {
    const run = await executeWorkflow(echoSpawner(), {
      script: `${META}
const errors = []
for (let i = 0; i < 3; i++) {
  try { await decide(null, {}) } catch (e) { errors.push(e.message) }
}
return errors`,
      maxTotalDecisions: 2,
    });
    expect(run.result).toEqual([
      "decide() state must be a string, object, or array.",
      "decide() state must be a string, object, or array.",
      "Lifetime decision cap of 2 reached.",
    ]);
    expect(run.totalTokens).toBe(0);
  });

  test("validates hook arguments", async () => {
    const run = await executeWorkflow(echoSpawner(), {
      script: `${META}
const errors = []
for (const call of [
  () => agent(''),
  () => agent('x', 'opts'),
  () => agent('x', {maxToolCalls: 0}),
  () => agent('x', {maxToolCalls: 1.5}),
  () => agent('x', {maxToolCalls: Number.MAX_SAFE_INTEGER + 1}),
  () => parallel('nope'),
  () => pipeline('nope'),
  () => phase(''),
]) {
  try { await call() } catch (e) { errors.push(e.message) }
}
return errors`,
    });
    expect(run.result).toEqual([
      "agent() requires a non-empty prompt string.",
      "agent() options must be an object.",
      "agent() maxToolCalls must be a positive safe integer.",
      "agent() maxToolCalls must be a positive safe integer.",
      "agent() maxToolCalls must be a positive safe integer.",
      "parallel() takes an array of zero-arg functions.",
      "pipeline() takes an array of items followed by stage functions.",
      "phase() requires a title string.",
    ]);
  });

  test("rejects TypeScript and missing meta with a clear parse error", async () => {
    await expect(
      executeWorkflow(echoSpawner(), {
        script: `${META}const x: number = 1\nreturn x`,
      }),
    ).rejects.toThrow(/plain JavaScript/);
    await expect(
      executeWorkflow(echoSpawner(), { script: "return 1" }),
    ).rejects.toThrow(/export const meta/);
  });

  test("appends each outcome to the journal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "workflow-journal-"));
    try {
      const journalPath = join(dir, "journal.jsonl");
      await executeWorkflow(echoSpawner(), {
        script: `${META}await agent('one', { label: 'L' }); await agent('two')`,
        journalPath,
      });
      const lines = readFileSync(journalPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines).toEqual([
        {
          callIndex: 0,
          label: "L",
          prompt: "one",
          outcome: { value: "echo:one", failed: false },
        },
        {
          callIndex: 1,
          label: "two",
          prompt: "two",
          outcome: { value: "echo:two", failed: false },
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("journals a continuation attempt with the same worker ID and raw result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "workflow-resume-journal-"));
    try {
      const journalPath = join(dir, "journal.jsonl");
      const seen: SubagentRequest[] = [];
      const run = await executeWorkflow(
        async (request, _signal, hooks) => {
          seen.push(request);
          hooks?.onStarted?.("conv-same-worker");
          return {
            value: request.prompt === "first" ? null : "raw reply",
            failed: request.prompt === "first",
            conversationId: "conv-same-worker",
          };
        },
        {
          script: `${META}
try { await agent('first') }
catch (error) { return await agent('continue', { conversationId: error.conversationId }) }`,
          journalPath,
        },
      );
      expect(run.result).toBe("raw reply");
      expect(seen.map((r) => r.options.conversationId)).toEqual([
        undefined,
        "conv-same-worker",
      ]);
      const entries = readFileSync(journalPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(entries).toHaveLength(4);
      expect(entries[0]).toMatchObject({
        kind: "agent_started",
        conversationId: "conv-same-worker",
      });
      expect(entries[1].outcome.conversationId).toBe("conv-same-worker");
      expect(entries[3]).toMatchObject({
        resumedConversationId: "conv-same-worker",
        outcome: { conversationId: "conv-same-worker", value: "raw reply" },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("abort rejects the run and interrupts in-flight subagents", async () => {
    const controller = new AbortController();
    let aborted = false;
    const spawner: SubagentSpawner = (_request, signal) =>
      new Promise<SubagentOutcome>((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve({ value: null, failed: true, error: "interrupted" });
        });
      });
    const events: WorkflowProgressEvent[] = [];
    const pending = executeWorkflow(spawner, {
      script: `${META}await agent('slow'); log('after')`,
      signal: controller.signal,
      onProgress: (event) => events.push(event),
    });
    await Bun.sleep(10);
    controller.abort();
    await expect(pending).rejects.toThrow("Workflow aborted.");
    expect(aborted).toBe(true);
    await Bun.sleep(10);
    // Nothing is emitted after the abort, even if the script body continues.
    expect(events.some((e) => e.kind === "log")).toBe(false);
  });

  test("an interrupted subagent still reports its outcome and tokens", async () => {
    const controller = new AbortController();
    const spawner: SubagentSpawner = (_request, signal) =>
      new Promise<SubagentOutcome>((resolve) => {
        signal.addEventListener("abort", () =>
          resolve({
            value: null,
            failed: true,
            error: "interrupted",
            totalTokens: 4_200,
          }),
        );
      });
    const events: WorkflowProgressEvent[] = [];
    const dir = mkdtempSync(join(tmpdir(), "workflow-abort-journal-"));
    try {
      const journalPath = join(dir, "journal.jsonl");
      const pending = executeWorkflow(spawner, {
        script: `${META}await agent('slow')`,
        signal: controller.signal,
        journalPath,
        onProgress: (event) => events.push(event),
      });
      await Bun.sleep(10);
      controller.abort();
      await expect(pending).rejects.toThrow("Workflow aborted.");
      // The terminal event and journal line carry what the worker consumed
      // before TaskStop, so /workflows and the journal do not undercount.
      expect(events.at(-1)).toMatchObject({
        kind: "agent",
        status: "error",
        detail: "interrupted",
        totalTokens: 4_200,
      });
      const journal = readFileSync(journalPath, "utf8").trim().split("\n");
      expect(journal).toHaveLength(1);
      expect(JSON.parse(journal[0] ?? "{}").outcome.totalTokens).toBe(4_200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("waits for un-awaited agent() calls before settling", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spawner: SubagentSpawner = async (request) => {
      if (request.prompt === "slow") await gate;
      return { value: request.prompt, failed: false, totalTokens: 10 };
    };
    let settledResult: unknown = "unsettled";
    const pending = executeWorkflow(spawner, {
      script: `${META}agent('slow'); return 'done'`,
    }).then((run) => {
      settledResult = run;
      return run;
    });
    await Bun.sleep(20);
    // The script returned, but its fire-and-forget worker is still running.
    expect(settledResult).toBe("unsettled");
    release();
    const run = await pending;
    expect(run).toMatchObject({
      result: "done",
      agentsSpawned: 1,
      totalTokens: 10,
    });
  });
});
