import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getCurrentAgentId } from "@/agent/context";
import {
  ensureLocalMemfsCheckout,
  getMemoryFilesystemRoot,
  isMemfsEnabledOnServer,
} from "@/agent/memory-filesystem";
import { appendArtifactServerDebugLogs } from "@/websocket/listener/commands/artifact-debug-store";
import { callArtifactServerFunction } from "@/websocket/listener/commands/artifacts";

interface ArtifactCallArgs {
  app_name: string;
  function_name: string;
  args?: unknown;
}

function emitMemoryUpdated(affectedPaths: string[]): void {
  if (affectedPaths.length === 0) return;
  try {
    // Lazy-import to avoid introducing websocket runtime deps at module load.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getActiveRuntime } =
      require("../../websocket/listener/runtime") as {
        getActiveRuntime: () => {
          socket: { readyState: number; send: (data: string) => void } | null;
        } | null;
      };

    const socket = getActiveRuntime()?.socket;
    if (!socket || socket.readyState !== 1) return;
    socket.send(
      JSON.stringify({
        type: "memory_updated",
        affected_paths: affectedPaths,
        timestamp: Date.now(),
      }),
    );
  } catch {
    // Best-effort only — never fail artifact_call because a UI refresh failed.
  }
}

export async function artifact_call(args: ArtifactCallArgs): Promise<{
  content: string;
}> {
  const agentId = getCurrentAgentId();
  if (!agentId) {
    throw new Error("artifact_call: current agent id is unavailable");
  }

  const memoryRoot = getMemoryFilesystemRoot(agentId);
  if (!existsSync(join(memoryRoot, ".git"))) {
    const enabled = await isMemfsEnabledOnServer(agentId);
    if (!enabled) {
      throw new Error("artifact_call: memfs is not enabled for this agent");
    }
    await ensureLocalMemfsCheckout(agentId);
  }

  const result = await callArtifactServerFunction({
    command: {
      type: "artifact_call",
      request_id: randomUUID(),
      agent_id: agentId,
      app_name: args.app_name,
      function_name: args.function_name,
      args: args.args,
    },
    agentId,
    memoryRoot,
  });

  appendArtifactServerDebugLogs({
    agentId,
    appName: args.app_name,
    logs: result.logs.map((log) => ({
      source: "server",
      level: log.level,
      message: log.message,
      timestamp: log.timestamp,
    })),
  });
  emitMemoryUpdated(result.updatedPaths);

  return {
    content: JSON.stringify(
      {
        result: result.result,
        updated_paths: result.updatedPaths,
        logs: result.logs,
      },
      null,
      2,
    ),
  };
}
