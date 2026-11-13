import { expect, test } from "bun:test";
import Letta from "@letta-ai/letta-client";
import { WebSocketServer } from "ws";
import type { MonitorState } from "@/backend/api/monitors";
import { apiRequest } from "@/backend/api/request";
import {
  resolveBackendMode,
  setConfiguredBackendMode,
} from "@/backend/backend-mode";
import { isManagedCloudRuntime } from "@/managed-cloud-runtime";
import { runWithRuntimeContext } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";
import { monitor, shutdownMonitors } from "@/tools/impl/monitor";
import { withMonitorState } from "@/tools/impl/monitor-state";
import {
  backgroundProcesses,
  clearBackgroundProcessCleanup,
} from "@/tools/impl/process_manager";
import { task_stop } from "@/tools/impl/task-stop";

test("cloud monitors persist their real lifecycle through the monitor API", async () => {
  if (!process.env.LETTA_API_KEY) throw new Error("LETTA_API_KEY is required");
  await settingsManager.initialize();
  const client = new Letta({ apiKey: process.env.LETTA_API_KEY });
  const existingAgent = process.env.LETTA_MONITOR_TEST_AGENT_ID;
  const agentId =
    existingAgent ??
    (
      await client.agents.create({
        name: "Monitor integration",
        model: "anthropic/claude-sonnet-4-6",
        include_base_tools: false,
        initial_message_sequence: [],
      })
    ).id;
  const conversation = await client.conversations.create({ agent_id: agentId });
  const previousMode = resolveBackendMode();
  setConfiguredBackendMode("api");
  const ids: string[] = [];
  const server = new WebSocketServer({ port: 0 });
  const scope = { agentId, conversationId: conversation.id };
  const read = (id: string) =>
    apiRequest<MonitorState>("GET", `/v1/monitors/${id}`);
  async function terminal(id: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const record = await read(id);
      if (record.status !== "running") return record;
      await Bun.sleep(50);
    }
    throw new Error("Monitor did not persist its terminal state");
  }
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing WS address");
    await runWithRuntimeContext(
      { ...scope, suppressActingUserFallback: true },
      async () => {
        for (const exitCode of [0, 7]) {
          const result = await monitor({
            description: "Command lifecycle",
            parentScope: scope,
            command: `exit ${exitCode}`,
          });
          ids.push(result.taskId);
          expect(await terminal(result.taskId)).toMatchObject({
            monitor_id: result.taskId,
            agent_id: agentId,
            conversation_id: conversation.id,
            status: exitCode === 0 ? "completed" : "failed",
            exit_code: exitCode,
            kind: "command",
            output_file: backgroundProcesses.get(result.taskId)?.outputFile,
          });
        }
        const secret = `monitor-secret-${crypto.randomUUID()}`;
        const running = await monitor({
          description: "Stop lifecycle",
          parentScope: scope,
          persistent: true,
          command: `"${process.execPath}" -e "setInterval(() => {}, 1000)" # ${secret}`,
          secretEnv: { MONITOR_SENTINEL: secret },
        });
        ids.push(running.taskId);
        const saved = await read(running.taskId);
        const expandedLifecycle = saved.args !== undefined;
        expect(saved.command).not.toContain(secret);
        expect(await task_stop({ task_id: running.taskId })).toMatchObject({
          killed: true,
        });
        expect((await read(running.taskId)).status).toBe(
          expandedLifecycle ? "stopped" : "failed",
        );

        const socket = await monitor({
          description: "Socket lifecycle",
          parentScope: scope,
          ws: { url: `ws://127.0.0.1:${address.port}` },
        });
        ids.push(socket.taskId);
        for (const peer of server.clients) peer.close(1000);
        expect(await terminal(socket.taskId)).toMatchObject({
          kind: "websocket",
          status: "completed",
        });

        const script = await monitor({
          description: "Script lifecycle",
          parentScope: scope,
          script: 'emit("ready"); return 42;',
        });
        ids.push(script.taskId);
        expect(await terminal(script.taskId)).toMatchObject({
          kind: "script",
          status: "completed",
        });

        await expect(
          withMonitorState(
            {
              description: "Startup failure",
              command: "not started",
              kind: "command",
              persistent: false,
              parentScope: scope,
            },
            (id) => {
              ids.push(id);
              throw new Error("Source could not start");
            },
          ),
        ).rejects.toThrow("Source could not start");
        const failedId = ids.at(-1);
        if (!failedId) throw new Error("Missing failed monitor ID");
        expect((await read(failedId)).status).toBe("failed");

        const shutdown = await monitor({
          description: "Shutdown lifecycle",
          parentScope: scope,
          persistent: true,
          ws: { url: `ws://127.0.0.1:${address.port}` },
        });
        ids.push(shutdown.taskId);
        await shutdownMonitors();
        expect((await read(shutdown.taskId)).status).toBe(
          expandedLifecycle
            ? isManagedCloudRuntime()
              ? "paused"
              : "stopped"
            : "failed",
        );
        // Durable records remain readable after the host discards its handles.
        backgroundProcesses.delete(shutdown.taskId);
        expect((await read(shutdown.taskId)).monitor_id).toBe(shutdown.taskId);
      },
    );
  } finally {
    for (const id of ids) {
      backgroundProcesses.get(id)?.process.kill("SIGKILL");
      clearBackgroundProcessCleanup(id);
      backgroundProcesses.delete(id);
      await apiRequest("DELETE", `/v1/monitors/${id}`);
    }
    for (const peer of server.clients) peer.terminate();
    server.close();
    setConfiguredBackendMode(previousMode);
    await client.conversations.delete(conversation.id);
    if (!existingAgent) await client.agents.delete(agentId);
  }
}, 120_000);
