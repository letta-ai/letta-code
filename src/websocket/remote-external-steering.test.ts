import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { clearAllSubagents } from "@/agent/subagent-state";
import {
  AppServerClient,
  type AppServerSocketConstructor,
} from "@/app-server-client";
import { __testSetBackend, type AgentCreateBody } from "@/backend";
import { createAssistantMessageStream } from "@/backend/dev/headless-turn-executor";
import { LocalBackend } from "@/backend/local";
import { settingsManager } from "@/settings-manager";
import { backgroundTasks } from "@/tools/impl/process_manager";
import { launchRemoteExternalCodingAgent } from "@/tools/impl/remote-external-coding-agent";
import { spawnBackgroundSubagentTask } from "@/tools/impl/task";
import type { SubagentSnapshot } from "@/types/protocol_v2";
import { type AppServerHandle, startAppServer } from "./app-server";

let home: string;
let server: AppServerHandle | undefined;
let client: AppServerClient | undefined;
const extraClients = new Set<AppServerClient>();
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
  for (const connection of extraClients) connection.close();
  extraClients.clear();
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

async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
  description: string,
): Promise<T> {
  for (let i = 0; i < 500; i++) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

const fakeClaude = String.raw`#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = (value) => appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(value) + "\n");
if (process.argv.includes("auth")) {
  process.stdout.write(JSON.stringify({ loggedIn: true }) + "\n");
  process.exit(0);
}
const resumeIndex = process.argv.indexOf("--resume");
log({ event: "started", args: process.argv.slice(2), resume: resumeIndex >= 0 ? process.argv[resumeIndex + 1] : null });
const output = (value) => process.stdout.write(JSON.stringify(value) + "\n");
output({ type: "system", subtype: "init", session_id: resumeIndex >= 0 ? process.argv[resumeIndex + 1] : null });
const start = () => {
  output({ type: "stream_event", event: { type: "message_start" } });
  output({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } });
};
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const value = JSON.parse(line);
  if (value.type === "control_request") {
    log({ event: "interrupt", requestId: value.request_id });
    output({ type: "control_response", response: { subtype: "success", request_id: value.request_id } });
    output({ type: "result", is_error: false, result: "interrupted result" });
    return;
  }
  const prompt = value.message?.content?.[0]?.text;
  log({ event: "prompt", prompt });
  if (prompt === "steer the active run" || prompt === "finish resumed run") {
    setTimeout(() => {
      start();
      output({
        type: "result",
        is_error: false,
        result: prompt === "steer the active run" ? "steered result" : "resumed result",
      });
    }, 25);
    return;
  }
  start();
});
`;

// The fake executable uses a POSIX shebang. Windows protocol behavior is
// covered by unit tests; this E2E test exercises real child-process signaling.
test.skipIf(process.platform === "win32")(
  "steers, resumes, stops, and scopes a remote external agent over a real websocket",
  async () => {
    home = await mkdtemp(join(tmpdir(), "remote-external-steering-"));
    const binDir = join(home, "bin");
    const fakePath = join(binDir, "claude");
    const logPath = join(home, "fake-claude.jsonl");
    await Bun.write(fakePath, fakeClaude);
    await chmod(fakePath, 0o755);
    await writeFile(logPath, "");
    setEnv("HOME", home);
    setEnv("LETTA_SCRATCHPAD", home);
    setEnv("LETTA_DISABLE_MODS", "1");
    setEnv("LETTA_DISABLE_CRON_SCHEDULER", "1");
    setEnv("LETTA_BASE_URL", "http://127.0.0.1:8283");
    setEnv("LETTA_LOCAL_BACKEND_DIR", join(home, "store"));
    setEnv("LETTA_LOCAL_BACKEND_EXECUTOR", "deterministic");
    setEnv("FAKE_CLAUDE_LOG", logPath);
    setEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);
    await settingsManager.reset();
    await settingsManager.initialize();
    const backend = new LocalBackend({
      storageDir: join(home, "store"),
      memfsEnabled: false,
      executor: {
        async execute() {
          return createAssistantMessageStream();
        },
      },
    });
    __testSetBackend(backend);
    const parent = await backend.createAgent({
      name: "Parent",
      model: "anthropic/claude-sonnet-4-6",
      system: "PARENT_PROMPT",
    } as AgentCreateBody);
    settingsManager.setMemfsEnabled(parent.id, false);
    await settingsManager.flush();
    const conversation = await backend.createConversation({
      agent_id: parent.id,
    });
    server = await startAppServer({ listen: "ws://127.0.0.1:0" });
    const connect = async () => {
      const connection = await new AppServerClient({
        url: server?.controlUrl as string,
        WebSocket: WebSocket as unknown as AppServerSocketConstructor,
        requestTimeoutMs: 15_000,
      }).connect();
      extraClients.add(connection);
      return connection;
    };
    client = await connect();
    extraClients.delete(client);
    const runtime = {
      agent_id: parent.id,
      conversation_id: conversation.id,
    };
    expect(
      (
        await client.runtimeStart({
          ...runtime,
          cwd: home,
          recover_approvals: false,
        })
      ).success,
    ).toBe(true);
    expect((await client.info()).capabilities.subagent_message).toBe(true);

    const snapshots: SubagentSnapshot[] = [];
    client.onMessage((message) => {
      if (
        message.type === "update_subagent_state" &&
        message.runtime?.agent_id === runtime.agent_id &&
        message.runtime.conversation_id === runtime.conversation_id
      ) {
        snapshots.push(...message.subagents);
      }
    });
    const parentScope = {
      agentId: runtime.agent_id,
      conversationId: runtime.conversation_id,
    };
    const launched = await launchRemoteExternalCodingAgent(
      {
        type: "claude-code",
        computer: "test computer",
        prompt: "initial assignment",
        description: "remote fake Claude",
        toolCallId: "launch-call",
        parentScope,
      },
      {
        spawn: spawnBackgroundSubagentTask,
        resolveComputer: async () => ({
          connectionId: "local-test",
          environment: {
            id: "environment-e2e",
            connectionId: "local-test",
            deviceId: "device-e2e",
            connectionName: "test computer",
            organizationId: "organization-e2e",
            podId: null,
            connectedAt: Date.now(),
            lastHeartbeat: Date.now(),
            lastSeenAt: Date.now(),
            firstSeenAt: Date.now(),
            metadata: {
              launch_subagent_notify_caller: true,
              subagent_message: true,
            },
          },
        }),
        connect: async () => connect(),
      },
    );
    expect(launched.success).toBe(true);
    if (!launched.success) throw new Error(launched.error);
    expect(launched.agent_id).toMatch(/^claude_[0-9a-f-]{36}@device-e2e$/);
    const bareAgentId = launched.agent_id?.split("@")[0] as string;
    expect(
      await waitFor(
        () =>
          snapshots.find(
            (entry) =>
              entry.tool_call_id === "launch-call" &&
              entry.agent_id === bareAgentId,
          ),
        "launch snapshot agent ID",
      ),
    ).toBeDefined();

    const steered = await client.sendSubagentMessage({
      runtime,
      agent_id: bareAgentId,
      message: "steer the active run",
      tool_call_id: "steer-call",
    });
    expect(steered).toMatchObject({ success: true, delivery: "steered" });
    await waitFor(
      () =>
        snapshots.find(
          (entry) =>
            entry.tool_call_id === "launch-call" &&
            entry.status === "completed" &&
            entry.result === "steered result",
        ),
      "steered completion snapshot",
    );
    const steeredLog = await waitFor(async () => {
      const records = (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event: string; prompt?: string });
      return records.some((entry) => entry.event === "interrupt") &&
        records.some(
          (entry) =>
            entry.event === "prompt" && entry.prompt === "steer the active run",
        )
        ? records
        : undefined;
    }, "fake Claude steering input");
    expect(steeredLog).toBeDefined();

    const wrongRuntime = {
      ...runtime,
      conversation_id: "different-conversation",
    };
    expect(
      await client.sendSubagentMessage({
        runtime: wrongRuntime,
        agent_id: bareAgentId,
        message: "must be rejected",
      }),
    ).toMatchObject({ success: false });
    expect(
      await client.stopSubagent({
        runtime: wrongRuntime,
        agent_id: bareAgentId,
      }),
    ).toMatchObject({ success: false, stopped: false });

    const resumed = await client.sendSubagentMessage({
      runtime,
      agent_id: bareAgentId,
      message: "resume after idle",
      tool_call_id: "resume-call",
    });
    expect(resumed).toMatchObject({ success: true, delivery: "resumed" });
    expect(
      await client.sendSubagentMessage({
        runtime,
        agent_id: bareAgentId,
        message: "finish resumed run",
      }),
    ).toMatchObject({ success: true, delivery: "steered" });
    await waitFor(
      () =>
        [...backgroundTasks.values()].find(
          (task) =>
            task.description === "Continue claude-code session" &&
            task.status === "completed",
        ),
      "resumed background task completion",
    );
    await client.sync({ runtime, recover_approvals: false });
    expect(
      await waitFor(
        () =>
          snapshots.find(
            (entry) =>
              entry.tool_call_id === "resume-call" &&
              entry.status === "completed" &&
              entry.result === "resumed result",
          ),
        "resumed completion snapshot",
      ),
    ).toBeDefined();
    const resumeStart = await waitFor(async () => {
      const records = (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event: string; resume?: string });
      return records.find(
        (entry) =>
          entry.event === "started" && entry.resume === bareAgentId.slice(7),
      );
    }, "fake Claude --resume launch");
    expect(resumeStart).toBeDefined();

    const stopLaunch = await client.launchSubagent({
      runtime,
      args: {
        subagent_type: "claude-code",
        prompt: "hold until stopped",
        description: "stoppable remote fake Claude",
      },
      tool_call_id: "stop-call",
      notify: "caller",
    });
    expect(stopLaunch.success).toBe(true);
    if (!stopLaunch.success) throw new Error(stopLaunch.error);
    const stopAgentId = stopLaunch.agent_id as string;
    const stopTask = backgroundTasks.get(stopLaunch.task_id);
    expect(stopTask?.status).toBe("running");
    const stopped = await client.stopSubagent({
      runtime,
      agent_id: stopAgentId,
    });
    expect(stopped).toMatchObject({ success: true, stopped: true });
    await stopTask?.completion;
    expect(stopTask?.status).not.toBe("running");
    expect(
      await waitFor(
        () =>
          snapshots.find(
            (entry) =>
              entry.tool_call_id === "stop-call" && entry.status === "error",
          ),
        "stopped snapshot",
      ),
    ).toBeDefined();
  },
  60_000,
);
