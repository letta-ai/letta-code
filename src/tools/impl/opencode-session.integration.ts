// Native CLI + real provider tests. Run by the OpenCode integration CI job.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSubagents, subscribe } from "@/agent/subagent-state";
import { runWithRuntimeContext } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";
import { runExternalCodingAgent } from "./external-coding-agent";
import { closeOpenCodeSessions, sendOpenCodeMessage } from "./opencode-session";
import { backgroundTasks } from "./process_manager";
import { send_agent_message } from "./send-agent-message";
import { launchSubagent } from "./task";
import { task_stop } from "./task-stop";

let root: string;
let cwd: string;
const oldEnv = { ...process.env };
const model = process.env.OPENCODE_TEST_MODEL ?? "openai/gpt-5.6-luna";
const parentAgentId = "agent-opencode-test";

beforeAll(async () => {
  if (!process.env.OPENAI_API_KEY)
    throw new Error(
      "OPENAI_API_KEY is required for native OpenCode integration tests",
    );
  root = await mkdtemp(join(tmpdir(), "letta-opencode-"));
  cwd = join(root, "project");
  await mkdir(cwd);
  for (const key of [
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
  ])
    process.env[key] = join(root, key);
  process.env.HOME = root;
  // Isolated project configuration proves default-agent/model and skill discovery.
  await writeFile(
    join(cwd, "opencode.json"),
    JSON.stringify({
      model,
      default_agent: "letta-test",
      agent: {
        "letta-test": {
          mode: "primary",
          prompt:
            "You are a test worker. Follow the user's file and shell instructions exactly.",
        },
      },
    }),
  );
  const skillDir = join(cwd, ".opencode", "skills", "proof");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    "---\nname: proof\ndescription: Load when asked for the project proof phrase\n---\nThe project proof phrase is NATIVE_SKILL_731.\n",
  );
  await settingsManager.initialize();
});

afterAll(async () => {
  await closeOpenCodeSessions();
  for (const key of Object.keys(process.env))
    if (!(key in oldEnv)) delete process.env[key];
  Object.assign(process.env, oldEnv);
  if (root) await rm(root, { recursive: true, force: true });
});

test("real OpenCode preserves skills, streams tools, and resumes persisted sessions through SendAgentMessage", async () => {
  const tools: string[] = [];
  let startedId = "";
  const first = await runExternalCodingAgent({
    type: "opencode",
    parentAgentId,
    cwd,
    prompt:
      "Load the proof skill and write its exact project proof phrase to proof.txt. Reply DONE.",
    onStarted: (id) => {
      startedId = id;
    },
    onToolCall: (call) => tools.push(call.name),
  });
  expect(first.success, first.error).toBe(true);
  expect(first.model).toBe(model);
  expect(first.agentId).toBe(startedId);
  expect(startedId).toMatch(/^opencode_ses_/);
  expect(tools).toContain("skill");
  expect((await readFile(join(cwd, "proof.txt"), "utf8")).trim()).toBe(
    "NATIVE_SKILL_731",
  );
  await closeOpenCodeSessions();
  const results = await runWithRuntimeContext(
    {
      agentId: parentAgentId,
      conversationId: "conv-opencode-test",
      workingDirectory: cwd,
    },
    () =>
      Promise.all(
        [0, 1].map(() =>
          send_agent_message({
            agent_id: startedId,
            message:
              "What was the exact project proof phrase you wrote in the preceding turn? Answer only that phrase.",
          }),
        ),
      ),
  );
  for (const result of results)
    expect(result.status, result.content).toBe("success");
  const receipts = results.map((result) => JSON.parse(result.content));
  expect(receipts.filter((receipt) => receipt.task_id)).toHaveLength(1);
  expect(
    receipts.filter((receipt) => receipt.delivery === "session/abort+prompt"),
  ).toHaveLength(1);
  const receipt = receipts.find((receipt) => receipt.task_id);
  expect(receipt.delivery).toBe("session/prompt");
  expect(receipt.task_id).toBeString();
  const task = backgroundTasks.get(receipt.task_id);
  expect(task).toBeDefined();
  await task?.completion;
  const output = await readFile(receipt.output_file, "utf8");
  expect(output).toContain("NATIVE_SKILL_731");
}, 180_000);

test("active steering replaces a native prompt without creating another task", async () => {
  let sessionId = "";
  let toolStarted!: () => void;
  const ready = new Promise<void>((resolve) => {
    toolStarted = resolve;
  });
  const first = runExternalCodingAgent({
    type: "opencode",
    parentAgentId,
    cwd,
    prompt:
      "Run the shell command sleep 30 before replying ORIGINAL. Do not skip running the command.",
    onStarted: (id) => {
      sessionId = id.slice("opencode_".length);
    },
    onToolCall: () => toolStarted(),
  });
  await Promise.race([
    ready,
    first.then((result) => {
      throw new Error(`Turn ended before steering: ${JSON.stringify(result)}`);
    }),
  ]);
  const steer = await sendOpenCodeMessage({
    sessionId,
    parentAgentId,
    cwd,
    prompt:
      "Stop waiting. Write STEERED_941 into steered.txt now, then reply STEERED_941.",
  });
  expect(steer.mode).toBe("steered");
  expect(steer.completion).toBeUndefined();
  const result = await first;
  expect(result.success, result.error).toBe(true);
  expect((await readFile(join(cwd, "steered.txt"), "utf8")).trim()).toBe(
    "STEERED_941",
  );
}, 180_000);

test("Agent launch returns an early native ID and TaskStop stops its background task", async () => {
  await runWithRuntimeContext(
    {
      agentId: parentAgentId,
      conversationId: "conv-opencode-test",
      workingDirectory: cwd,
    },
    async () => {
      const launch = await launchSubagent({
        subagent_type: "opencode",
        description: "Cancellation proof",
        prompt: "Run sleep 30 in the shell, then reply done.",
        mcp: { inherit: false },
      });
      expect(launch.success).toBe(true);
      if (!launch.success || !launch.task_id || !launch.agent_id)
        throw new Error(JSON.stringify(launch));
      expect(launch.agent_id).toMatch(/^opencode_ses_/);
      const task = backgroundTasks.get(launch.task_id);
      expect(task?.status).toBe("running");
      if (!task?.completion)
        throw new Error("Background task has no completion promise");
      let unsubscribe = () => {};
      try {
        await Promise.race([
          new Promise<void>((resolve) => {
            const check = () => {
              if (
                getSubagents().some(
                  (child) =>
                    child.agentId === launch.agent_id &&
                    child.toolCalls.length > 0,
                )
              )
                resolve();
            };
            unsubscribe = subscribe(check);
            check();
          }),
          task.completion.then(() => {
            throw new Error("Task ended before cancellation");
          }),
        ]);
        expect(await task_stop({ task_id: launch.task_id })).toEqual({
          killed: true,
        });
        expect(task?.status).toBe("failed");
        const resumed = await sendOpenCodeMessage({
          sessionId: launch.agent_id.slice("opencode_".length),
          parentAgentId,
          cwd,
          prompt: "Do not run any commands. Reply RESUMED_AFTER_STOP.",
        });
        expect(resumed.mode).toBe("new_turn");
        const result = await resumed.completion;
        expect(result?.success, result?.error).toBe(true);
        expect(result?.report).toContain("RESUMED_AFTER_STOP");
      } finally {
        unsubscribe();
      }
    },
  );
}, 180_000);

test("native provider errors and interactive permission requests fail instead of hanging or auto-approving", async () => {
  const invalid = await runExternalCodingAgent({
    type: "opencode",
    parentAgentId,
    cwd,
    model: "openai/does-not-exist-letta",
    prompt: "Hello",
  });
  expect(invalid.success).toBe(false);
  expect(invalid.error).toBeTruthy();
  const restricted = join(root, "restricted");
  await mkdir(restricted);
  await writeFile(
    join(restricted, "opencode.json"),
    JSON.stringify({ model, permission: { bash: "ask" } }),
  );
  const denied = await runExternalCodingAgent({
    type: "opencode",
    parentAgentId,
    cwd: restricted,
    prompt:
      "Run exactly this shell command with the bash tool: printf approved > forbidden.txt",
  });
  expect(denied.success, denied.report).toBe(false);
  expect(denied.error).toContain("permission approval");
  expect(await Bun.file(join(restricted, "forbidden.txt")).exists()).toBe(
    false,
  );
}, 180_000);
