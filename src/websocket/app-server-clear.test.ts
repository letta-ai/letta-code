import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerClient } from "@/app-server-client";
import { __testSetBackend } from "@/backend";
import { LocalBackend, LocalStore } from "@/backend/local";
import { settingsManager } from "@/settings-manager";
import { type AppServerHandle, startAppServer } from "./app-server";
import {
  createAcceptedInputDispositionLedger,
  loadDurableQueuedInputs,
} from "./listener/input-disposition";
import { getActiveRuntime } from "./listener/runtime";

for (const scopeKind of ["default", "conversation"] as const) {
  test(`clear preserves ${scopeKind} input identity across sends and restart`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "letta-clear-"));
    const env = {
      LETTA_DISABLE_MODS: process.env.LETTA_DISABLE_MODS,
      LETTA_DISABLE_CRON_SCHEDULER: process.env.LETTA_DISABLE_CRON_SCHEDULER,
    };
    process.env.LETTA_DISABLE_MODS = "1";
    process.env.LETTA_DISABLE_CRON_SCHEDULER = "1";
    let server: AppServerHandle | undefined;
    let client: AppServerClient | undefined;
    try {
      const backend = new LocalBackend({
        storageDir: dir,
        executionMode: "deterministic",
        memfsEnabled: false,
      });
      __testSetBackend(backend);
      const agent = await backend.createAgent({ name: "Clear regression" });
      await settingsManager.initialize();
      settingsManager.setMemfsEnabled(agent.id, false);
      const scope = {
        agent_id: agent.id,
        conversation_id:
          scopeKind === "default"
            ? "default"
            : (await backend.createConversation({ agent_id: agent.id })).id,
      };
      const path = join(dir, "input-dispositions.json");
      const start = async () => {
        server = await startAppServer({ listen: "ws://127.0.0.1:0" });
        const runtime = getActiveRuntime();
        if (!runtime) throw new Error("App-server runtime is missing");
        runtime.acceptedInputDispositionLedger =
          createAcceptedInputDispositionLedger({ persistentPath: path });
        client = await new AppServerClient({
          url: server.controlUrl,
        }).connect();
        return runtime;
      };
      let runtime = await start();
      const send = async (id: string) => {
        const connected = client;
        if (!connected) throw new Error("App-server client is missing");
        const finished = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            unsubscribe();
            reject(new Error("Turn did not finish"));
          }, 10_000);
          const unsubscribe = connected.onMessage((message) => {
            if (
              message.type === "turn_finished" &&
              message.runtime.agent_id === scope.agent_id &&
              message.runtime.conversation_id === scope.conversation_id
            ) {
              clearTimeout(timer);
              unsubscribe();
              resolve();
            }
          });
        });
        // Attach a rejection handler even when admission itself fails.
        void finished.catch(() => {});
        const ack = await connected.request("input", {
          runtime: scope,
          payload: {
            kind: "create_message",
            messages: [{ role: "user", content: id, client_message_id: id }],
          },
        });
        expect(ack).toMatchObject({ accepted: true });
        await finished;
        // A successful response is insufficient: the on-disk ledger must be
        // readable by a newly allocated listener, with no completed input replay.
        expect(loadDurableQueuedInputs(runtime)).toEqual([]);
      };
      await send("before-clear");
      if (!client || !server) throw new Error("App-server is missing");
      const response = await client.request("execute_command", {
        runtime: scope,
        command_id: "clear",
      });
      expect(response).toMatchObject({ success: true });
      await send("after-clear");
      await send("second-after-clear");
      client.close();
      await server.close();
      runtime = await start();
      await send("after-restart");
      const messages = new LocalStore(agent.id, {
        storageDir: dir,
      }).listConversationMessages(scope.conversation_id, {
        agent_id: agent.id,
      });
      expect(
        messages.filter(
          (message) => message.message_type === "assistant_message",
        ),
      ).toHaveLength(4);
      const ledger = JSON.parse(await readFile(path, "utf8"));
      expect(Object.values(ledger.entries)).toHaveLength(4);
      for (const entry of Object.values(ledger.entries)) {
        expect(entry).toMatchObject({
          replayCompleted: true,
          runtimeKey: `agent:${agent.id}::conversation:${scope.conversation_id}`,
        });
        expect(entry).not.toHaveProperty("queuedInput");
      }
    } finally {
      client?.close();
      await server?.close();
      __testSetBackend(null);
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
}
