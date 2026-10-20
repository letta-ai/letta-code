import { describe, expect, test } from "bun:test";
import { ReplSession } from "@/tools/repl/repl-session";
import type { ReplTurnRecord } from "@/tools/repl/repl-worker";
import type {
  SubagentOutcome,
  SubagentRequest,
  SubagentSpawner,
} from "@/tools/workflow/types";

interface PendingTurn {
  request: SubagentRequest;
  signal: AbortSignal;
  finish(value: unknown): void;
}

/** A spawner whose turns finish when the test says so, or fail when aborted. */
function scriptedSpawner() {
  const turns: PendingTurn[] = [];
  let conversations = 0;
  let notify: (() => void) | undefined;
  const spawner: SubagentSpawner = (request, signal, hooks) =>
    new Promise<SubagentOutcome>((resolve) => {
      const conversationId =
        request.options.conversationId ?? `conv-w${++conversations}`;
      if (signal.aborted) {
        resolve({ value: null, failed: true, error: "interrupted" });
        return;
      }
      hooks?.onStarted?.(conversationId);
      const settle = (outcome: SubagentOutcome) =>
        resolve({ ...outcome, conversationId });
      signal.addEventListener(
        "abort",
        () =>
          settle({
            value: null,
            failed: true,
            error: "Workflow subagent interrupted",
          }),
        { once: true },
      );
      turns.push({
        request,
        signal,
        finish: (value) => settle({ value, failed: false }),
      });
      notify?.();
    });
  const nextTurn = async (index: number): Promise<PendingTurn> => {
    while (!turns[index]) {
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
    return turns[index] as PendingTurn;
  };
  return { spawner, turns, nextTurn };
}

function session(
  spawner: SubagentSpawner,
  onWorkerSettled?: (id: string, turn: ReplTurnRecord) => void,
) {
  let created = 0;
  const repl = new ReplSession({
    createSpawner: async () => {
      created++;
      return { spawner, cleanup: async () => {} };
    },
    onWorkerSettled: (worker, turn) => onWorkerSettled?.(worker.id, turn),
  });
  return { repl, spawnerCount: () => created };
}

describe("ReplSession cells", () => {
  test("keeps assigned globals across cells and captures console output", async () => {
    const { repl } = session(scriptedSpawner().spawner);
    await repl.runCell("counter = 1; const local = 5;");
    const run = await repl.runCell(
      "counter += args.step; console.log('at', counter); return [counter, typeof local];",
      { args: { step: 2 } },
    );
    expect(run).toEqual({ result: [3, "undefined"], output: ["at 3"] });
  });

  test("overlapping cells keep their own args", async () => {
    const { repl } = session(scriptedSpawner().spawner);
    await repl.runCell(
      "gate = new Promise((resolve) => { release = resolve; });",
    );
    const first = repl.runCell("await gate; return args.n;", {
      args: { n: 1 },
    });
    const second = await repl.runCell("release(); return args.n;", {
      args: { n: 2 },
    });
    expect(second.result).toBe(2);
    expect((await first).result).toBe(1);
  });

  test("calls tools through the latest cell's bindings", async () => {
    const { repl } = session(scriptedSpawner().spawner);
    const calls: string[] = [];
    let cleaned = 0;
    const scope = (tag: string) => ({
      builtinToolNames: ["Read"],
      callTool: async (name: string, args: Record<string, unknown>) => {
        calls.push(`${tag}:${name}:${String(args.file_path)}`);
        return { content: [{ type: "text", text: `${tag} contents` }] };
      },
      cleanup: async () => {
        cleaned++;
      },
    });
    const first = await repl.runCell(
      "return [await tools.Read({ file_path: 'a' }), tools.Write === undefined];",
      { scope: scope("one") },
    );
    expect(first.result).toEqual(["one contents", true]);
    const second = await repl.runCell(
      "return await tools.Read({ file_path: 'b' });",
      { scope: scope("two") },
    );
    expect(second.result).toBe("two contents");
    expect(calls).toEqual(["one:Read:a", "two:Read:b"]);
    // The replaced scope is released once no cell uses it.
    expect(cleaned).toBe(1);
  });

  test("reports parse errors as plain JavaScript errors", async () => {
    const { repl } = session(scriptedSpawner().spawner);
    await expect(repl.runCell("const x: number = 1;")).rejects.toThrow(
      "Repl cell failed to parse",
    );
  });
});

describe("ReplSession workers", () => {
  test("a worker started in one cell is steered in a later cell", async () => {
    const fake = scriptedSpawner();
    const { repl, spawnerCount } = session(fake.spawner);
    const started = await repl.runCell(
      "w = agent.start('Audit auth.ts', { label: 'audit', model: 'openai/gpt-5.6-luna' }); return w.info();",
    );
    expect(started.result).toMatchObject({ id: "w1", status: "running" });

    const firstTurn = await fake.nextTurn(0);
    expect(firstTurn.request.prompt).toBe("Audit auth.ts");

    const steer = repl.runCell(
      "return await w.send('Focus on cookie flags.');",
    );
    const steered = await fake.nextTurn(1);
    expect(firstTurn.signal.aborted).toBe(true);
    expect(steered.request.prompt).toBe("Focus on cookie flags.");
    // Continuations target the same conversation and drop creation-only options.
    expect(steered.request.options).toMatchObject({
      conversationId: "conv-w1",
      label: "audit",
    });
    expect(steered.request.options.model).toBeUndefined();
    steered.finish("cookies lack Secure");
    expect((await steer).result).toBe("cookies lack Secure");

    const info = await repl.runCell("return agent.get('audit').info();");
    expect(info.result).toMatchObject({
      status: "idle",
      turns: 2,
      lastResult: "cookies lack Secure",
      conversationId: "conv-w1",
    });
    expect(spawnerCount()).toBe(1);
  });

  test("pause holds messages until resume, which continues the conversation", async () => {
    const fake = scriptedSpawner();
    const { repl } = session(fake.spawner);
    await repl.runCell("w = agent.start('Long task');");
    const first = await fake.nextTurn(0);
    const paused = await repl.runCell("return await w.pause();");
    expect(first.signal.aborted).toBe(true);
    expect(paused.result).toMatchObject({ status: "paused" });

    await repl.runCell("held = w.send('Also update the docs.');");
    await Promise.resolve();
    expect(fake.turns).toHaveLength(1);

    const resumed = repl.runCell("w.resume(); return await w.result();");
    const continued = await fake.nextTurn(1);
    expect(continued.request.prompt).toBe("Also update the docs.");
    expect(continued.request.options.conversationId).toBe("conv-w1");
    continued.finish("done with docs");
    expect((await resumed).result).toBe("done with docs");
  });

  test("resume without a message continues an interrupted turn", async () => {
    const fake = scriptedSpawner();
    const { repl } = session(fake.spawner);
    await repl.runCell(
      "w = agent.start('Long task'); await Promise.resolve();",
    );
    await fake.nextTurn(0);
    await repl.runCell("await w.pause();");
    const resumed = repl.runCell("return await w.resume();");
    const continued = await fake.nextTurn(1);
    expect(continued.request.prompt).toContain("Continue the task");
    continued.finish("finished");
    expect((await resumed).result).toBe("finished");
  });

  test("send to an idle worker continues the conversation without interrupting", async () => {
    const fake = scriptedSpawner();
    const { repl } = session(fake.spawner);
    await repl.runCell("w = agent.start('First');");
    (await fake.nextTurn(0)).finish("first done");
    await repl.runCell("await w.result();");
    const followUp = repl.runCell("return await w.send('Second');");
    const second = await fake.nextTurn(1);
    expect(second.signal.aborted).toBe(false);
    expect(second.request.options.conversationId).toBe("conv-w1");
    second.finish("second done");
    expect((await followUp).result).toBe("second done");
  });

  test("queued sends run after the active turn without interrupting it", async () => {
    const fake = scriptedSpawner();
    const { repl } = session(fake.spawner);
    await repl.runCell("w = agent.start('Step one');");
    const first = await fake.nextTurn(0);
    await repl.runCell("next = w.send('Step two', { interrupt: false });");
    expect(first.signal.aborted).toBe(false);
    first.finish("one");
    const second = await fake.nextTurn(1);
    expect(second.request.prompt).toBe("Step two");
    second.finish("two");
    expect((await repl.runCell("return await next;")).result).toBe("two");
  });

  test("agent() resolves to the reply and failures reject", async () => {
    const fake = scriptedSpawner();
    const { repl } = session(fake.spawner);
    const run = repl.runCell("return await agent('Summarize');");
    (await fake.nextTurn(0)).finish({ summary: "ok" });
    expect((await run).result).toEqual({ summary: "ok" });

    const stopped = repl.runCell(
      "w = agent.start('x'); await w.stop(); try { await w.result(); } catch (e) { return e.message; }",
    );
    expect((await stopped).result).toBe("Worker w2 is stopped.");
  });

  test("notifies only for turns that settle while no cell is running", async () => {
    const fake = scriptedSpawner();
    const settled: string[] = [];
    const { repl } = session(fake.spawner, (id, turn) =>
      settled.push(`${id}:${turn.status}`),
    );
    await repl.runCell("w = agent.start('Background job');");
    (await fake.nextTurn(0)).finish("done");
    await repl.runCell("return await w.result();");
    expect(settled).toEqual(["w1:done"]);
  });

  test("close stops workers and refuses new cells", async () => {
    const fake = scriptedSpawner();
    const { repl } = session(fake.spawner);
    await repl.runCell("w = agent.start('Forever');");
    const turn = await fake.nextTurn(0);
    await repl.close();
    expect(turn.signal.aborted).toBe(true);
    expect(repl.workerInfo()[0]).toMatchObject({ status: "stopped" });
    await expect(repl.runCell("return 1;")).rejects.toThrow(
      "Repl session was reset.",
    );
  });
});
