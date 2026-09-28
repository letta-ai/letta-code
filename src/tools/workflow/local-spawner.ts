/**
 * Use the Agent SDK against a local App Server. The SDK's managed local query
 * path uses the API backend; an explicit server URL keeps these conversations
 * in the already-selected local backend without reimplementing query streaming.
 */
import { randomUUID } from "node:crypto";
import { type AppServerHandle, startAppServer } from "@/websocket/app-server";
import { getActiveRuntime } from "@/websocket/listener/runtime";
import { loadAgentSdk } from "./sdk-loader";
import { createSdkSpawner, type SdkSpawnerConfig } from "./sdk-spawner";
import type { SubagentSpawner } from "./types";

export interface LocalSpawnerHandle {
  spawner: SubagentSpawner;
  cleanup(): Promise<void>;
}

export async function createLocalSpawnerHandle(
  config: SdkSpawnerConfig,
): Promise<LocalSpawnerHandle> {
  // A Workflow inside an app-server turn borrows its listener; an owned server
  // here would stop that listener and interrupt the invoking conversation.
  const runtime = getActiveRuntime();
  const server: AppServerHandle = await startAppServer({
    listen: "ws://127.0.0.1:0",
    startProcessServices: false,
    ...(runtime ? { runtime } : {}),
    connectionName: `workflow-${randomUUID()}`,
  });
  try {
    const sdk = await loadAgentSdk();
    const client = sdk.createRemoteClient(server.controlUrl);
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
          await server.close();
        }
      },
    };
  } catch (error) {
    await server.close();
    throw error;
  }
}
