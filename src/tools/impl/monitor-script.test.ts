import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configureBackendMode } from "@/backend";
import { resolveBackendMode } from "@/backend/backend-mode";
import { runWithRuntimeContext } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";
import {
  clearCapturedToolExecutionContexts,
  executeTool,
  getExecutionContextById,
  releaseToolExecutionContext,
} from "@/tools/manager";
import { prepareToolExecutionContextForResolvedTarget } from "@/tools/toolset";
import {
  clearPendingMessages,
  type QueuedMessage,
  setMessageQueueAdder,
} from "@/utils/message-queue-bridge";
import { backgroundProcesses } from "./process_manager";
import { task_stop } from "./task-stop";

const originalHome = process.env.HOME;
const originalLocalDir = process.env.LETTA_LOCAL_BACKEND_DIR;
const originalScratchpad = process.env.LETTA_SCRATCHPAD;
const originalMode = resolveBackendMode();
const agentId = "agent-monitor-script-test";
const conversationId = "conv-monitor-script-test";
const serverPath = fileURLToPath(
  new URL(
    "./dist/index.js",
    import.meta.resolve("@modelcontextprotocol/server-everything/package.json"),
  ),
);
let home: string;
let queued: QueuedMessage[];

beforeEach(async () => {
  queued = [];
  setMessageQueueAdder((message) => queued.push(message));
  await settingsManager.reset();
  home = mkdtempSync(join(tmpdir(), "monitor-script-test-"));
  process.env.HOME = home;
  process.env.LETTA_LOCAL_BACKEND_DIR = join(home, "local");
  process.env.LETTA_SCRATCHPAD = join(home, "scratch");
  configureBackendMode("local");
  await settingsManager.initialize();
});

afterEach(async () => {
  for (const processState of backgroundProcesses.values()) {
    processState.completionNotificationSuppressed = true;
    processState.process.kill("SIGKILL");
  }
  // Let aborted scripts settle and close their MCP sessions.
  await Bun.sleep(50);
  backgroundProcesses.clear();
  setMessageQueueAdder(null);
  clearPendingMessages();
  clearCapturedToolExecutionContexts();
  await settingsManager.reset();
  configureBackendMode(originalMode);
  for (const [key, value] of [
    ["HOME", originalHome],
    ["LETTA_LOCAL_BACKEND_DIR", originalLocalDir],
    ["LETTA_SCRATCHPAD", originalScratchpad],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

async function waitFor(condition: () => boolean, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await Bun.sleep(10);
  }
}

/** Launches Monitor through the real manager, as a model tool call would. */
async function launch(
  input: Record<string, unknown>,
  mode: "unrestricted" | "strict" = "unrestricted",
) {
  const { preparedToolContext } =
    await prepareToolExecutionContextForResolvedTarget({
      toolsetPreference: "letta",
      clientToolAllowlist: ["Monitor", "Read", "Write"],
      workingDirectory: home,
      permissionModeState: { mode },
      runtimeContext: { agentId, conversationId, workingDirectory: home },
    });
  const contextId = preparedToolContext.contextId;
  const result = await runWithRuntimeContext(
    {
      agentId,
      conversationId,
      workingDirectory: home,
      toolContextId: contextId,
    },
    () =>
      executeTool(
        "Monitor",
        { description: "script test", ...input },
        { toolContextId: contextId },
      ),
  );
  // Successful launches return a text content array; errors return a string.
  const text =
    typeof result.toolReturn === "string"
      ? result.toolReturn
      : ((result.toolReturn as Array<{ text: string }>)[0]?.text ?? "");
  const taskId = text.match(/task (monitor_\S+),/)?.[1] ?? "";
  const outputFile = text.match(/^Output file: (.+)$/m)?.[1] ?? "";
  return { result, text, taskId, outputFile, contextId };
}

test("polls a built-in tool with state across polls, deduping and emitting changes, then returns", async () => {
  const file = join(home, "status.txt");
  writeFileSync(file, "queued");
  const { result, taskId, outputFile } = await launch({
    args: { file },
    script: `
let last;
while (true) {
  const text = await tools.Read({ file_path: args.file });
  const status = text.includes('done') ? 'done' : text.includes('running') ? 'running' : 'queued';
  if (status !== last) { emit('status: ' + status); last = status; }
  if (status === 'done') return { final: status };
  console.log('polled', status);
  await sleep(20);
}`,
  });
  expect(result.status).toBe("success");
  expect(taskId).toStartWith("monitor_");
  expect(backgroundProcesses.get(taskId)?.monitorSource).toBe("script");

  await waitFor(() => queued.some((m) => m.text.includes("status: queued")));
  writeFileSync(file, "running");
  await waitFor(() => queued.some((m) => m.text.includes("status: running")));
  writeFileSync(file, "done");
  await waitFor(() => backgroundProcesses.get(taskId)?.status === "completed");
  await waitFor(() => queued.some((m) => m.text.includes("<status>completed")));

  const texts = queued.map((m) => m.text).join("\n");
  // Each status change is one event, despite many polls of the same state.
  expect(texts.match(/<event>status: queued/g)).toHaveLength(1);
  expect(texts.match(/<event>status: running/g)).toHaveLength(1);
  expect(texts).toContain('{"final":"done"}');
  expect(texts).not.toContain("polled");
  for (const message of queued) {
    expect(message).toMatchObject({ agentId, conversationId });
  }
  expect(readFileSync(outputFile, "utf8")).toContain("polled queued");
}, 15000);

test("calls MCP tools and keeps working after the launching turn's tool context is released", async () => {
  settingsManager.setMcpServers(agentId, [
    {
      name: "everything",
      transport: "stdio",
      command: process.execPath,
      args: [serverPath],
    },
  ]);
  const { taskId, contextId } = await launch({
    persistent: true,
    script: `
let i = 0;
while (true) {
  emit(await tools.mcp__everything__echo({ message: 'poll ' + i++ }));
  await sleep(i === 1 ? 300 : 20);
}`,
  });
  await waitFor(() => queued.some((m) => m.text.includes("Echo: poll 0")));
  // The TUI releases the turn's context when the turn ends.
  releaseToolExecutionContext(contextId);
  expect(getExecutionContextById(contextId)).toBeDefined();
  await waitFor(() => queued.some((m) => m.text.includes("Echo: poll 3")));
  expect(backgroundProcesses.get(taskId)?.status).toBe("running");

  const stopped = await task_stop({ task_id: taskId });
  expect(stopped.killed).toBe(true);
  await waitFor(() => getExecutionContextById(contextId) === undefined);
  const count = queued.length;
  await Bun.sleep(100);
  // Stopping is silent and ends the loop.
  expect(queued.length).toBe(count);
  expect(backgroundProcesses.get(taskId)?.status).toBe("failed");
}, 20000);

test("exposes decide() and validates requests before calling the provider", async () => {
  const { taskId } = await launch({
    script: `
emit(typeof decide);
decide(null, {}); // unawaited rejection must not crash the host
try { await decide(null, {}); } catch (e) { emit(e.message); }
try { await decide('s', { q: { type: 'noul', instructions: 'x' } }, 1); } catch (e) { emit(e.message); }`,
  });
  await waitFor(() => backgroundProcesses.get(taskId)?.status === "completed");
  await waitFor(() => queued.some((m) => m.text.includes("options must")));
  const text = queued.map((m) => m.text).join("\n");
  expect(text).toContain("function");
  expect(text).toContain("decide() state must be a string, object, or array.");
  expect(text).toContain("decide() options must be an object.");
});

test("TaskStop ends a loop that catches every error", async () => {
  const file = join(home, "loop.txt");
  writeFileSync(file, "x");
  const { taskId, contextId } = await launch({
    persistent: true,
    args: { file },
    script: `
let polls = 0;
while (true) {
  try { await tools.Read({ file_path: args.file }); if (++polls === 1) emit('polling'); } catch {}
  try { await sleep(20); } catch {}
}`,
  });
  await waitFor(() => queued.length > 0);
  releaseToolExecutionContext(contextId);
  expect((await task_stop({ task_id: taskId })).killed).toBe(true);
  // A spinning loop would starve these timers and the run's cleanup.
  await waitFor(() => getExecutionContextById(contextId) === undefined);
  expect(backgroundProcesses.get(taskId)?.status).toBe("failed");
});

test("a throw fails the monitor with a scrubbed error, and approval-needing calls throw", async () => {
  const { taskId } = await launch(
    { script: "await tools.Write({ file_path: 'x', content: 'y' });" },
    "strict",
  );
  await waitFor(() => backgroundProcesses.get(taskId)?.status === "failed");
  await waitFor(() => queued.some((m) => m.text.includes("<status>failed")));
  const text = queued.map((m) => m.text).join("\n");
  expect(text).toContain("script failed");
  expect(text).toContain("needs approval");
}, 15000);

test("timeouts stop the loop and report once", async () => {
  const { taskId } = await launch({
    timeout_ms: 1000,
    script: "while (true) await sleep(50);",
  });
  await waitFor(() => backgroundProcesses.get(taskId)?.status === "failed");
  await Bun.sleep(100);
  const timeouts = queued.filter((m) => m.text.includes("timed out"));
  expect(timeouts).toHaveLength(1);
  expect(queued.some((m) => m.text.includes("<status>failed"))).toBe(false);
}, 15000);

test("requires exactly one source and excludes Monitor from nested tools", async () => {
  const both = await launch({ script: "return 1", command: "echo hi" });
  expect(both.result.status).toBe("error");
  expect(both.text).toContain("exactly one of command, ws, or script");

  const { taskId } = await launch({
    script: "return [typeof tools.Monitor, typeof tools.Read, typeof emit];",
  });
  await waitFor(() => queued.some((m) => m.text.includes("<status>completed")));
  expect(queued.at(-1)?.text).toContain('["undefined","function","function"]');
  expect(backgroundProcesses.get(taskId)?.status).toBe("completed");
}, 15000);
