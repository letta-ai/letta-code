import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { backgroundProcesses } from "@/tools/impl/process_manager";
import { task_output } from "@/tools/impl/task-output";
import { task_stop } from "@/tools/impl/task-stop";
import { workflow } from "@/tools/impl/workflow";
import { getWorkflowExecution } from "@/tools/workflow/execution-registry";

// This directory runs in the credentialed API CI matrix. Do not add an opt-in
// flag: the SDK/App Server boundary is not covered by the injected unit spawner.
const testWithAPI = process.env.LETTA_API_KEY ? test : test.skip;

testWithAPI(
  "Workflow runs real agent-free queries through the built CLI and replays their journal",
  async () => {
    const root = resolve(import.meta.dir, "../..");
    // The SDK must run this revision, not its nested published CLI dependency.
    const build = Bun.spawn([process.execPath, "run", "build"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [buildOut, buildErr, buildCode] = await Promise.all([
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
      build.exited,
    ]);
    expect(buildCode, `${buildOut}\n${buildErr}`).toBe(0);

    const home = await mkdtemp(join(tmpdir(), "letta-workflow-api-"));
    const keys = [
      "HOME",
      "USERPROFILE",
      "LETTA_CLI_PATH",
      "LETTA_SCRATCHPAD",
      "LETTA_DISABLE_MODS",
    ] as const;
    const previous = Object.fromEntries(
      keys.map((key) => [key, process.env[key]]),
    );
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.LETTA_SCRATCHPAD = home;
    process.env.LETTA_CLI_PATH = join(root, "letta.js");
    process.env.LETTA_DISABLE_MODS = "1";
    const tasks: string[] = [];

    async function launch(args: Parameters<typeof workflow>[0]) {
      const launched = await workflow({
        model: "openai/gpt-5.6-luna",
        allowedTools: [],
        ...args,
      });
      expect(launched.status, launched.toolReturn).toBe("success");
      const taskId = /Task ID: (\S+)/.exec(launched.toolReturn)?.[1];
      expect(taskId).toBeDefined();
      if (!taskId) throw new Error("Missing workflow task ID");
      tasks.push(taskId);
      const output = await task_output({
        task_id: taskId,
        block: true,
        timeout: 120_000,
      });
      expect(output.status, output.message).toBe("completed");
      const record = getWorkflowExecution(taskId);
      if (!record) throw new Error("Workflow disappeared before inspection");
      const raw = await readFile(record.outputFile, "utf8");
      const result = raw
        .split("[result]\n")[1]
        ?.split("\n\nPer-agent results:")[0];
      if (!result) throw new Error(`No workflow result: ${raw}`);
      return { record, result: JSON.parse(result) };
    }

    try {
      const script = `export const meta = {
        name: 'api-integration', description: 'Parallel arithmetic and replay'
      };
      phase('Extract');
      const values = await parallel([1, 2].map(n => () => agent(
        'Return the integer ' + n + ' as the value field via StructuredOutput.',
        { label: 'item-' + n, timeoutMs: 60000,
          schema: { type: 'object', properties: { value: { type: 'integer' } },
                    required: ['value'], additionalProperties: false } }
      )));
      if (values.some(value => value === null)) throw new Error('Extraction failed');
      phase('Sum');
      return values.reduce((sum, value) => sum + value.value, 0);`;
      const first = await launch({ script, maxConcurrent: 2 });
      expect(first.result).toMatchObject({
        result: 3,
        agentsSpawned: 2,
        cacheHits: 0,
      });
      const journal = (
        await readFile(join(first.record.executionDir, "journal.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(journal).toHaveLength(2);
      expect(journal.every((entry) => entry.outcome.failed === false)).toBe(
        true,
      );
      expect(journal.map((entry) => entry.outcome.value.value).sort()).toEqual([
        1, 2,
      ]);

      const replay = await launch({
        scriptPath: first.record.scriptPath,
        resumeFromExecutionId: first.record.executionId,
      });
      expect(replay.result).toMatchObject({
        result: 3,
        agentsSpawned: 0,
        cacheHits: 2,
        totalCostUsd: 0,
        totalTokens: 0,
      });
    } finally {
      for (const taskId of tasks) {
        const task = backgroundProcesses.get(taskId);
        if (task?.status === "running") await task_stop({ task_id: taskId });
      }
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(home, { recursive: true, force: true });
    }
  },
  240_000,
);
