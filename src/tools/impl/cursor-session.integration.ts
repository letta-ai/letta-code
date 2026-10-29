// Real Cursor SDK/provider, selected from Cursor's live catalog by the CI job.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSubagents, subscribe } from "@/agent/subagent-state";
import { runWithRuntimeContext } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";
import { closeCursorSessions, sendCursorMessage } from "./cursor-session";
import { resolveCursorTestModel } from "./cursor-test-model";
import { runExternalCodingAgent } from "./external-coding-agent";
import { backgroundTasks } from "./process_manager";
import { send_agent_message } from "./send-agent-message";
import { launchSubagent } from "./task";
import { task_stop } from "./task-stop";

let root: string;
let cwd: string;
const oldHome = process.env.HOME;
const parentAgentId = "agent-cursor-integration";
let model: string;

beforeAll(async () => {
  if (!process.env.CURSOR_API_KEY)
    throw new Error(
      "CURSOR_API_KEY is required for the Cursor lifecycle tests",
    );
  root = await mkdtemp(join(tmpdir(), "letta-cursor-"));
  cwd = join(root, "project");
  await mkdir(cwd);
  model = await resolveCursorTestModel(cwd);
  process.env.HOME = root;
  await settingsManager.initialize();
});

afterAll(async () => {
  await closeCursorSessions();
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (root) await rm(root, { recursive: true, force: true });
});

test("Cursor edits files, streams tool calls, and resumes history and checkout through SendAgentMessage", async () => {
  const tools: string[] = [];
  let handle = "";
  const first = await runExternalCodingAgent({
    type: "cursor",
    parentAgentId,
    cwd,
    model,
    prompt:
      "Remember the phrase CURSOR_PROOF_731 and write it to proof.txt. Reply DONE.",
    onStarted: (id) => {
      handle = id;
    },
    onToolCall: (call) => tools.push(call.name),
  });
  expect(first.success, first.error).toBe(true);
  expect(first.model).toBe(model);
  expect(first.agentId).toBe(handle);
  expect(tools.length).toBeGreaterThan(0);
  expect((await readFile(join(cwd, "proof.txt"), "utf8")).trim()).toBe(
    "CURSOR_PROOF_731",
  );
  await closeCursorSessions();
  // A changed parent cwd must not move a persisted native session.
  await runWithRuntimeContext(
    {
      agentId: parentAgentId,
      conversationId: "conv-cursor-test",
      workingDirectory: root,
    },
    async () => {
      const response = await send_agent_message({
        agent_id: handle,
        message:
          "Without reading any files, write the phrase I asked you to remember into resumed.txt. Reply DONE.",
      });
      expect(response.status).toBe("success");
      const receipt = JSON.parse(response.content);
      const task = backgroundTasks.get(receipt.task_id);
      expect(task).toBeDefined();
      await task?.completion;
      expect(task?.status).toBe("completed");
      expect((await readFile(join(cwd, "resumed.txt"), "utf8")).trim()).toBe(
        "CURSOR_PROOF_731",
      );
    },
  );
}, 180_000);

test("Cursor in-flight messages execute once whether delivered as steering or a follow-up", async () => {
  let id = "";
  let toolStarted!: () => void;
  const ready = new Promise<void>((resolve) => {
    toolStarted = resolve;
  });
  const first = runExternalCodingAgent({
    type: "cursor",
    parentAgentId,
    cwd,
    model,
    prompt:
      "Run sleep 10 in the shell, then reply ORIGINAL. Do not skip the shell command.",
    onStarted: (handle) => {
      id = handle.slice("cursor_".length);
    },
    onToolCall: () => toolStarted(),
  });
  await Promise.race([
    ready,
    first.then((result) => {
      throw new Error(`Ended before steering: ${JSON.stringify(result)}`);
    }),
  ]);
  const receipt = await sendCursorMessage({
    parentAgentId,
    sessionId: id,
    cwd,
    prompt:
      "Append exactly one line containing STEERED_941 to steered.txt, then reply DONE. Do not repeat the append.",
  });
  // Both are documented SDK outcomes. Assert the delivery's actual task contract.
  if (receipt.mode === "steered") expect(receipt.completion).toBeUndefined();
  else expect(receipt.completion).toBeDefined();
  const result = await first;
  expect(result.success, result.error).toBe(true);
  if (receipt.completion) {
    const followup = await receipt.completion;
    expect(followup.success, followup.error).toBe(true);
  }
  expect((await readFile(join(cwd, "steered.txt"), "utf8")).trim()).toBe(
    "STEERED_941",
  );
}, 180_000);

test("Agent returns a native Cursor handle and TaskStop terminates its running shell", async () => {
  await runWithRuntimeContext(
    {
      agentId: parentAgentId,
      conversationId: "conv-cursor-stop",
      workingDirectory: cwd,
    },
    async () => {
      const launch = await launchSubagent({
        subagent_type: "cursor",
        model,
        description: "Cursor cancellation proof",
        prompt:
          "Run exactly this shell command: echo $$ > cursor-shell.pid; sleep 30; echo SURVIVED > cursor-after-stop.txt. Do not skip the command. Then reply DONE.",
        mcp: { inherit: false },
      });
      if (!launch.success || !launch.task_id || !launch.agent_id)
        throw new Error(JSON.stringify(launch));
      expect(launch.agent_id).toMatch(/^cursor_/);
      const task = backgroundTasks.get(launch.task_id);
      if (!task?.completion) throw new Error("No task completion promise");
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
        let pid = 0;
        const deadline = Date.now() + 10_000;
        while (!pid && Date.now() < deadline) {
          pid = Number(
            await readFile(join(cwd, "cursor-shell.pid"), "utf8").catch(
              () => "",
            ),
          );
          if (!pid) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(pid).toBeGreaterThan(0);
        expect(await task_stop({ task_id: launch.task_id })).toEqual({
          killed: true,
        });
        expect(task.status).toBe("failed");
        expect(() => process.kill(pid, 0)).toThrow();
        expect(
          await readFile(join(cwd, "cursor-after-stop.txt"), "utf8").catch(
            () => null,
          ),
        ).toBeNull();
      } finally {
        unsubscribe();
      }
    },
  );
}, 180_000);
