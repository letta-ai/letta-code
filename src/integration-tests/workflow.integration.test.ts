import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Letta from "@letta-ai/letta-client";
import { settingsManager } from "@/settings-manager";
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
    const tasks: string[] = [];
    const settingsWereReady = settingsManager.isReady;
    const children = new Set<string>();
    let nestedInvokerId: string | undefined;
    const client = new Letta({
      apiKey: process.env.LETTA_API_KEY,
      baseURL: process.env.LETTA_BASE_URL || "https://api.letta.com",
    });
    const parent = await client.agents.create({
      name: "Workflow lineage integration parent",
      model: "openai/gpt-5.6-luna",
      system: "Reply concisely.",
      include_base_tools: false,
      include_base_tool_rules: false,
      initial_message_sequence: [],
    });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.LETTA_SCRATCHPAD = home;
    process.env.LETTA_CLI_PATH = join(root, "letta.js");
    process.env.LETTA_DISABLE_MODS = "1";

    async function launch(args: Parameters<typeof workflow>[0]) {
      const launched = await workflow({
        model: "openai/gpt-5.6-luna",
        allowedTools: [],
        parentScope: { agentId: parent.id, conversationId: "default" },
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
      const record = getWorkflowExecution(taskId);
      if (!record) throw new Error("Workflow disappeared before inspection");
      const journal = (
        await readFile(join(record.executionDir, "journal.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      for (const entry of journal) {
        for (const id of entry.outcome.conversationIds ?? []) children.add(id);
      }
      expect(output.status, output.message).toBe("completed");
      const raw = await readFile(record.outputFile, "utf8");
      const result = raw
        .split("[result]\n")[1]
        ?.split("\n\nPer-agent results:")[0];
      if (!result) throw new Error(`No workflow result: ${raw}`);
      return { record, result: JSON.parse(result), journal };
    }

    try {
      await settingsManager.initialize();
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
      const journal = first.journal;
      expect(journal).toHaveLength(2);
      expect(children.size).toBeGreaterThanOrEqual(2);
      for (const id of children) {
        const conversation = await client.conversations.retrieve(id);
        expect(conversation).toMatchObject({
          agent_id: null,
          parent_agent_id: parent.id,
          is_subagent: true,
          name: expect.stringMatching(/^item-[12]$/),
        });
      }
      expect(journal.every((entry) => entry.outcome.failed === false)).toBe(
        true,
      );
      expect(journal.map((entry) => entry.outcome.value.value).sort()).toEqual([
        1, 2,
      ]);

      const invoker = await client.post<{ id: string }>(
        "/v1/conversations/ephemeral",
        {
          body: {
            model: "openai/gpt-5.6-luna",
            system: "Reply concisely.",
            parent_agent_id: parent.id,
            name: "Workflow nested invoker",
            is_subagent: true,
          },
        },
      );
      nestedInvokerId = invoker.id;
      const replay = await launch({
        parentScope: { agentId: invoker.id, conversationId: invoker.id },
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
      if (!settingsWereReady) await settingsManager.reset();
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(home, { recursive: true, force: true });
      try {
        if (nestedInvokerId) children.add(nestedInvokerId);
        await Promise.all(
          [...children].map((id) => client.conversations.delete(id)),
        );
      } finally {
        await client.agents.delete(parent.id);
      }
    }
  },
  240_000,
);
