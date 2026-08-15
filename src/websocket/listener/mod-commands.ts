import { sendMessageStreamWithBackend } from "@/agent/message";
import { getBackend } from "@/backend";
import {
  parseModCommandArgv,
  runModCommandWithTimeout,
} from "@/cli/mods/command-runtime";
import { createModConversationHandle } from "@/mods/conversation-handle";
import type {
  ModCommand,
  ModCommandContext,
  ModCommandResult,
} from "@/mods/types";
import { getConversationWorkingDirectory } from "./cwd";
import { createListenerModContext } from "./mod-adapter";

export {
  getListenerModCommand,
  listListenerModCommands,
} from "./mod-command-registry";

import { getConversationPermissionModeState } from "./permission-mode";
import type { ConversationRuntime } from "./types";

/**
 * Run a mod command in the listener and return its result. Builds a
 * ModCommandContext that mirrors the TUI command path (createModConversationHandle
 * with the shared sendMessageStreamWithBackend so fork/send/updateLlmConfig work
 * across local and Letta Cloud backends).
 */
export async function runListenerModCommand(
  conversationRuntime: ConversationRuntime,
  modCommand: ModCommand,
  parsed: { commandId: string; args: string; rawInput: string },
): Promise<ModCommandResult> {
  const { listener, agentId, conversationId } = conversationRuntime;
  const cwd = getConversationWorkingDirectory(
    listener,
    agentId,
    conversationId,
  );
  const permissionMode = getConversationPermissionModeState(
    listener,
    agentId,
    conversationId,
  ).mode;

  const modContext = createListenerModContext({
    sessionId: conversationId,
    workingDirectory: cwd,
    agent: agentId ? { id: agentId } : null,
    permissionMode,
    toolset: conversationRuntime.currentToolset,
  });

  const conversation = createModConversationHandle({
    agentId,
    backend: getBackend(),
    conversationId,
    sendMessageStream: sendMessageStreamWithBackend,
    workingDirectory: cwd,
  });

  const context: ModCommandContext = {
    ...modContext,
    args: parsed.args,
    argv: parseModCommandArgv(parsed.args),
    command: parsed.commandId,
    conversation: { ...conversation, id: conversationId },
    rawInput: parsed.rawInput,
  };

  return runModCommandWithTimeout(modCommand, context);
}
