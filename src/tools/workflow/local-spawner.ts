/**
 * Use the Agent SDK against a local App Server. The SDK's managed local query
 * path uses the API backend; an explicit local App Server URL keeps these
 * conversations in the selected local backend without reimplementing query streaming.
 */
import { randomUUID } from "node:crypto";
import { type AppServerHandle, startAppServer } from "@/websocket/app-server";
import { getActiveRuntime } from "@/websocket/listener/runtime";
import type { ListenerRuntime } from "@/websocket/listener/types";
import { loadAgentSdk } from "./sdk-loader";
import { createSdkSpawner, type SdkSpawnerConfig } from "./sdk-spawner";
import type { SubagentSpawner } from "./types";

export interface LocalSpawnerHandle {
  spawner: SubagentSpawner;
  cleanup(): Promise<void>;
}

interface OwnedWorkflowRuntime {
  runtime: ListenerRuntime;
  server: AppServerHandle;
  users: number;
}

// App Server startup and release both change the active runtime. Serialize
// them so two headless/TUI Workflows cannot independently decide to own it.
let lifecycle = Promise.resolve();
let ownedRuntime: OwnedWorkflowRuntime | null = null;

function serializeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const result = lifecycle.then(operation, operation);
  lifecycle = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function acquireServer(): Promise<{
  server: AppServerHandle;
  release(): Promise<void>;
}> {
  return serializeLifecycle(async () => {
    // A Workflow inside an app-server turn borrows its listener; an owned
    // server here would stop that listener and interrupt the parent turn.
    const runtime = getActiveRuntime();
    const owned = ownedRuntime?.runtime === runtime ? ownedRuntime : null;
    const server = await startAppServer({
      listen: "ws://127.0.0.1:0",
      startProcessServices: false,
      ...(runtime ? { runtime } : {}),
      connectionName: `workflow-${randomUUID()}`,
    });
    const active = runtime === null ? getActiveRuntime() : null;
    if (runtime === null && active === null) {
      await server.close();
      throw new Error(
        "Workflow App Server did not retain its listener runtime",
      );
    }
    const lease =
      owned ?? (active ? { runtime: active, server, users: 0 } : null);
    if (lease) {
      lease.users++;
      if (!owned) ownedRuntime = lease;
    }
    let released = false;
    return {
      server,
      release: async () => {
        if (released) return;
        released = true;
        await serializeLifecycle(async () => {
          if (!lease) {
            await server.close();
            return;
          }
          try {
            if (server !== lease.server) await server.close();
          } finally {
            lease.users--;
            if (lease.users === 0) {
              if (ownedRuntime === lease) ownedRuntime = null;
              await lease.server.close();
            }
          }
        });
      },
    };
  });
}

export async function createLocalSpawnerHandle(
  config: SdkSpawnerConfig,
): Promise<LocalSpawnerHandle> {
  const { server, release } = await acquireServer();
  try {
    const sdk = await loadAgentSdk();
    const client = sdk.createLocalClient(server.controlUrl);
    const run = createSdkSpawner(client, {
      ...config,
      // An installed SDK may ignore conversationId. Local continuation stays
      // explicit until it can be verified against local persisted runs.
      supportsAgentFreeResume: false,
    });
    return {
      spawner: (request, signal, hooks) =>
        request.options.conversationId
          ? Promise.resolve({
              value: null,
              failed: true,
              error: "Local Workflow worker continuation is not supported yet",
            })
          : run(request, signal, hooks),
      cleanup: async () => {
        try {
          await client[Symbol.asyncDispose]?.();
        } finally {
          await release();
        }
      },
    };
  } catch (error) {
    await release();
    throw error;
  }
}
