import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type WebSocket from "ws";
import { settingsManager } from "@/settings-manager";
import type {
  GetCwdMapCommand,
  SetBootWorkingDirectoryCommand,
  SetBootWorkingDirectoryResponseMessage,
} from "@/types/protocol_v2";
import {
  getBootWorkingDirectory,
  getExportedCwdMap,
  getWorkingDirectoryScopeKey,
  setBootWorkingDirectory,
} from "@/websocket/listener/cwd";
import { emitDeviceStatusUpdate } from "@/websocket/listener/protocol-outbound";
import type { ListenerRuntime } from "@/websocket/listener/types";
import type { SafeSocketSend } from "./types";

async function resolveDirectory(
  requestedPath: string,
  currentBootWorkingDirectory: string,
): Promise<string> {
  const trimmedPath = requestedPath.trim();
  if (!trimmedPath) {
    throw new Error("Working directory cannot be empty");
  }

  const resolvedPath = path.isAbsolute(trimmedPath)
    ? trimmedPath
    : path.resolve(currentBootWorkingDirectory, trimmedPath);
  const normalizedPath = await realpath(resolvedPath);
  const stats = await stat(normalizedPath);
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${normalizedPath}`);
  }
  return normalizedPath;
}

function getCwdScopeKeyFromRuntimeKey(runtimeKey: string): string | null {
  const marker = "::conversation:";
  const markerIndex = runtimeKey.lastIndexOf(marker);
  if (!runtimeKey.startsWith("agent:") || markerIndex === -1) {
    return null;
  }

  const conversationId = runtimeKey.slice(markerIndex + marker.length);
  return conversationId === "default"
    ? runtimeKey
    : `conversation:${conversationId}`;
}

function applyScopeUpdates(socket: WebSocket, runtime: ListenerRuntime): void {
  for (const [runtimeKey, state] of runtime.reminderStateByConversation) {
    const scopeKey = getCwdScopeKeyFromRuntimeKey(runtimeKey);
    if (!scopeKey || runtime.workingDirectoryByConversation.has(scopeKey)) {
      continue;
    }
    state.hasSentSessionContext = false;
    state.pendingSessionContextReason = "cwd_changed";
  }

  for (const conversationRuntime of runtime.conversationRuntimes.values()) {
    const scopeKey = getWorkingDirectoryScopeKey(
      conversationRuntime.agentId,
      conversationRuntime.conversationId,
    );
    if (
      runtime.workingDirectoryByConversation.has(scopeKey) ||
      conversationRuntime.activeWorkingDirectory
    ) {
      continue;
    }
    emitDeviceStatusUpdate(socket, conversationRuntime, {
      agent_id: conversationRuntime.agentId,
      conversation_id: conversationRuntime.conversationId,
    });
  }
}

export async function handleSetBootWorkingDirectoryCommand(
  command: SetBootWorkingDirectoryCommand,
  context: {
    socket: WebSocket;
    runtime: ListenerRuntime;
    safeSocketSend: SafeSocketSend;
  },
): Promise<void> {
  const { socket, runtime, safeSocketSend } = context;
  try {
    const normalizedPath = await resolveDirectory(
      command.cwd,
      getBootWorkingDirectory(runtime),
    );
    getExportedCwdMap(runtime);

    await Promise.all([
      settingsManager.loadProjectSettings(normalizedPath),
      settingsManager.loadLocalProjectSettings(normalizedPath),
    ]);

    if (setBootWorkingDirectory(runtime, normalizedPath)) {
      applyScopeUpdates(socket, runtime);
    }

    safeSocketSend(
      socket,
      {
        type: "set_boot_working_directory_response",
        request_id: command.request_id,
        success: true,
        boot_working_directory: getBootWorkingDirectory(runtime),
        cwd_revision: runtime.workingDirectoryRevision ?? 0,
      } satisfies SetBootWorkingDirectoryResponseMessage,
      "set_boot_working_directory_response",
      "set_boot_working_directory",
    );
  } catch (error) {
    safeSocketSend(
      socket,
      {
        type: "set_boot_working_directory_response",
        request_id: command.request_id,
        success: false,
        boot_working_directory: getBootWorkingDirectory(runtime),
        cwd_revision: runtime.workingDirectoryRevision ?? 0,
        error:
          error instanceof Error
            ? error.message
            : "Working directory change failed",
      } satisfies SetBootWorkingDirectoryResponseMessage,
      "set_boot_working_directory_response",
      "set_boot_working_directory",
    );
  }
}

export async function handleCwdProtocolCommand(
  command: GetCwdMapCommand | SetBootWorkingDirectoryCommand,
  context: {
    socket: WebSocket;
    runtime: ListenerRuntime;
    safeSocketSend: SafeSocketSend;
  },
): Promise<void> {
  if (command.type === "set_boot_working_directory") {
    await handleSetBootWorkingDirectoryCommand(command, context);
    return;
  }

  context.safeSocketSend(
    context.socket,
    {
      type: "get_cwd_map_response",
      request_id: command.request_id,
      success: true,
      cwd_map: getExportedCwdMap(context.runtime),
      boot_working_directory: getBootWorkingDirectory(context.runtime),
    },
    "get_cwd_map_response",
    "get_cwd_map",
  );
}
