import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { Stream } from "@letta-ai/letta-client/streaming";
import WebSocket from "ws";
import { clearAllSubagents, getSnapshot } from "@/agent/subagent-state";
import {
  AppServerClient,
  type AppServerSocketConstructor,
} from "@/app-server-client";
import { __testSetBackend, type AgentCreateBody } from "@/backend";
import { createAssistantMessageStream } from "@/backend/dev/headless-turn-executor";
import { LocalBackend } from "@/backend/local";
import { settingsManager } from "@/settings-manager";
import { backgroundTasks } from "@/tools/impl/process_manager";
import type { LaunchSubagentResponse } from "@/types/subagent-protocol";
import { type AppServerHandle, startAppServer } from "./app-server";

let home: string;
let server: AppServerHandle | undefined;
let client: AppServerClient | undefined;
const savedEnv = new Map<string, string | undefined>();
function setEnv(key: string, value: string) {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  process.env[key] = value;
}

afterEach(async () => {
  for (const task of backgroundTasks.values()) task.abortController?.abort();
  await Promise.all(
    [...backgroundTasks.values()].map((task) => task.completion),
  );
  client?.close();
  await server?.close();
  backgroundTasks.clear();
  clearAllSubagents();
  __testSetBackend(null);
  await settingsManager.reset();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  if (home) await rm(home, { recursive: true, force: true });
});

test("external tool launches a prepared child through the real App Server and child CLI", async () => {
  home = await mkdtemp(join(tmpdir(), "launch-subagent-"));
  setEnv("HOME", home);
  setEnv("LETTA_SCRATCHPAD", home);
  setEnv("LETTA_DISABLE_MODS", "1");
  setEnv("LETTA_DISABLE_CRON_SCHEDULER", "1");
  setEnv("LETTA_LOCAL_BACKEND_DIR", join(home, "store"));
  setEnv("LETTA_LOCAL_BACKEND_EXECUTOR", "deterministic");
  setEnv(
    "LETTA_CODE_BIN",
    process.env.LETTA_TEST_SUBAGENT_BIN ?? process.execPath,
  );
  setEnv(
    "LETTA_CODE_BIN_ARGS_JSON",
    process.env.LETTA_TEST_SUBAGENT_ARGS_JSON ??
      JSON.stringify([
        "--loader=.md:text",
        "--loader=.mdx:text",
        "--loader=.txt:text",
        resolve(import.meta.dir, "../index.ts"),
      ]),
  );
  await settingsManager.reset();
  await settingsManager.initialize();
  let issuedDispatch = false;
  const backend = new LocalBackend({
    storageDir: join(home, "store"),
    memfsEnabled: false,
    executor: {
      async execute() {
        if (issuedDispatch) return createAssistantMessageStream();
        issuedDispatch = true;
        return {
          controller: new AbortController(),
          async *[Symbol.asyncIterator]() {
            yield {
              message_type: "approval_request_message",
              tool_call: {
                tool_call_id: "dispatch-1",
                name: "dispatch_child",
                arguments: "{}",
              },
            };
            yield {
              message_type: "stop_reason",
              stop_reason: "requires_approval",
            };
          },
        } as unknown as Stream<LettaStreamingResponse>;
      },
    },
  });
  __testSetBackend(backend);
  const parent = await backend.createAgent({
    name: "Parent",
    model: "anthropic/claude-sonnet-4-6",
    system: "PARENT_PROMPT",
  } as AgentCreateBody);
  const worker = await backend.createAgent({
    name: "Worker",
    model: "anthropic/claude-sonnet-4-6",
    system: "WORKER_PROMPT",
  } as AgentCreateBody);
  settingsManager.setMemfsEnabled(parent.id, false);
  settingsManager.setMemfsEnabled(worker.id, false);
  await settingsManager.flush();
  const parentConv = await backend.createConversation({ agent_id: parent.id });
  const child = await backend.createConversation({ agent_id: worker.id });
  const originalParent = await backend.retrieveAgent(parent.id);
  const originalWorker = await backend.retrieveAgent(worker.id);
  server = await startAppServer({ listen: "ws://127.0.0.1:0" });
  client = await new AppServerClient({
    url: server.controlUrl,
    WebSocket: WebSocket as unknown as AppServerSocketConstructor,
    requestTimeoutMs: 15_000,
  }).connect();
  const connectedClient = client;
  expect((await client.info()).capabilities.launch_subagent).toBe(true);
  const runtime = { agent_id: parent.id, conversation_id: parentConv.id };
  expect(
    (
      await client.runtimeStart({
        ...runtime,
        cwd: home,
        recover_approvals: false,
        external_tools: [
          {
            tools: [
              {
                name: "dispatch_child",
                description: "Launch the prepared child",
                parameters: { type: "object", properties: {} },
              },
            ],
          },
        ],
      })
    ).success,
  ).toBe(true);
  const dispatched = Promise.withResolvers<LaunchSubagentResponse>();
  client.onExternalToolCall(async (call) => {
    try {
      const result = await connectedClient.launchSubagent({
        runtime,
        tool_call_id: call.tool_call_id,
        args: {
          subagent_type: "custom",
          conversation_id: child.id,
          prompt: "Reply from the prepared worker",
          description: "Prepared worker",
        },
      });
      dispatched.resolve(result);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      dispatched.reject(error);
      throw error;
    }
  });
  client.input({
    runtime,
    payload: {
      kind: "create_message",
      messages: [{ role: "user", content: "Dispatch the worker" }],
    },
  });
  const result = await dispatched.promise;
  expect(result.success).toBe(true);
  if (!result.success) throw new Error(result.error);
  expect(result.conversation_id).toBe(child.id);
  expect(result.agent_id).toBe(worker.id);
  const task = backgroundTasks.get(result.task_id);
  expect(task?.runtimeScope).toEqual({
    agentId: parent.id,
    conversationId: parentConv.id,
  });
  expect(
    getSnapshot().agents.find((a) => a.conversationId === child.id)?.toolCallId,
  ).toBe("dispatch-1");
  await task?.completion;
  for (let i = 0; task?.status === "running" && i < 500; i++)
    await Bun.sleep(10);
  expect(task?.status, task?.error).toBe("completed");
  expect(readFileSync(task?.outputFile as string, "utf8")).toContain("pong");
  expect((await backend.retrieveAgent(parent.id)).system).toBe(
    originalParent.system,
  );
  expect((await backend.retrieveAgent(worker.id)).system).toBe(
    originalWorker.system,
  );
  const failure = await client.launchSubagent({
    runtime,
    args: {
      subagent_type: "custom",
      conversation_id: parentConv.id,
      prompt: "bad",
      description: "bad",
    },
  });
  expect(failure).toMatchObject({
    success: false,
    error: "A subagent cannot run in its parent conversation",
  });
}, 60_000);
