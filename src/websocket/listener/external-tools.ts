import type WebSocket from "ws";
import {
  type ExternalToolDefinition,
  registerExternalTools,
  setExternalToolExecutor,
  unregisterExternalTools,
} from "@/tools/manager";
import type {
  ExternalToolCallRequestMessage,
  ExternalToolCallResponseCommand,
  ExternalToolDefinitionPayload,
  RuntimeScope,
  RuntimeStartExternalToolsGroup,
} from "@/types/protocol_v2";
import type { ListenerRuntime } from "@/websocket/listener/types";

const EXTERNAL_TOOL_CALL_TIMEOUT_MS = 5 * 60 * 1000;
const WEBSOCKET_OPEN = 1;

const registeredToolsByRuntime = new WeakMap<
  ListenerRuntime,
  Map<string, ExternalToolDefinition[]>
>();
const controllerByRegistrationKey = new Map<
  string,
  { runtime: ListenerRuntime; socket: WebSocket }
>();

function isSocketOpen(socket: WebSocket | null): socket is WebSocket {
  return socket?.readyState === WEBSOCKET_OPEN;
}

function getPendingExternalToolCalls(runtime: ListenerRuntime) {
  runtime.pendingExternalToolCalls ??= new Map();
  return runtime.pendingExternalToolCalls;
}

function getRegisteredTools(runtime: ListenerRuntime) {
  let registeredTools = registeredToolsByRuntime.get(runtime);
  if (!registeredTools) {
    registeredTools = new Map();
    registeredToolsByRuntime.set(runtime, registeredTools);
  }
  return registeredTools;
}

function getRuntimeKey(runtime: RuntimeScope): string {
  return `${runtime.agent_id}:${runtime.conversation_id}`;
}

function getToolRegistrationKey(
  runtime: RuntimeScope,
  scopeId: string | undefined,
  toolName: string,
): string {
  return JSON.stringify([
    "runtime",
    runtime.agent_id,
    runtime.conversation_id,
    scopeId ?? null,
    toolName,
  ]);
}

function toExternalToolDefinition(
  tool: ExternalToolDefinitionPayload,
  runtime: RuntimeScope,
  scopeId?: string,
): ExternalToolDefinition {
  return {
    name: tool.name,
    ...(tool.label !== undefined ? { label: tool.label } : {}),
    description: tool.description,
    parameters: tool.parameters,
    registrationKey: getToolRegistrationKey(runtime, scopeId, tool.name),
    ...(scopeId !== undefined ? { scopeId } : {}),
    runtime: {
      agentId: runtime.agent_id,
      conversationId: runtime.conversation_id,
    },
  };
}

function sendJson(socket: WebSocket, payload: unknown): void {
  socket.send(JSON.stringify(payload));
}

export function installExternalToolBridge(_runtime: ListenerRuntime): void {
  setExternalToolExecutor(async (toolCallId, toolName, input, context) => {
    const registrationKey = context?.tool.registrationKey;
    const controller = registrationKey
      ? controllerByRegistrationKey.get(registrationKey)
      : undefined;
    if (
      !controller ||
      !isSocketOpen(controller.socket) ||
      controller.runtime.intentionallyClosed
    ) {
      throw new Error("External tool controller is not connected");
    }
    const { runtime, socket } = controller;

    const requestId = `external-tool-${crypto.randomUUID()}`;
    const toolRuntime = context?.tool.runtime;
    const requestRuntime =
      toolRuntime?.agentId && toolRuntime.conversationId
        ? {
            agent_id: toolRuntime.agentId,
            conversation_id: toolRuntime.conversationId,
          }
        : undefined;
    const request: ExternalToolCallRequestMessage = {
      type: "external_tool_call_request",
      request_id: requestId,
      ...(requestRuntime ? { runtime: requestRuntime } : {}),
      ...(context?.tool.scopeId !== undefined
        ? { scope_id: context.tool.scopeId }
        : {}),
      tool_call_id: toolCallId,
      tool_name: toolName,
      input,
    };

    const result = await new Promise<{
      content: Array<{
        type: string;
        text?: string;
        data?: string;
        mimeType?: string;
      }>;
      isError: boolean;
    }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        getPendingExternalToolCalls(runtime).delete(requestId);
        reject(new Error(`External tool call timed out: ${toolName}`));
      }, EXTERNAL_TOOL_CALL_TIMEOUT_MS);

      getPendingExternalToolCalls(runtime).set(requestId, {
        resolve: (response) => {
          resolve({
            content: [...response.content],
            isError: response.is_error === true,
          });
        },
        reject,
        timeout,
        controllerSocket: socket,
      });

      try {
        sendJson(socket, request);
      } catch (error) {
        clearTimeout(timeout);
        getPendingExternalToolCalls(runtime).delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    return result;
  });
}

export function registerRuntimeExternalTools(
  runtime: ListenerRuntime,
  runtimeScope: RuntimeScope,
  groups: readonly RuntimeStartExternalToolsGroup[] = [],
  controllerSocket: WebSocket | null = runtime.socket,
): void {
  const registeredTools = getRegisteredTools(runtime);
  const runtimeKey = getRuntimeKey(runtimeScope);
  const previousTools = registeredTools.get(runtimeKey) ?? [];
  unregisterExternalTools(previousTools);
  for (const tool of previousTools) {
    if (
      tool.registrationKey &&
      controllerByRegistrationKey.get(tool.registrationKey)?.runtime === runtime
    ) {
      controllerByRegistrationKey.delete(tool.registrationKey);
    }
  }

  const tools = groups.flatMap((group) =>
    group.tools.map((tool) =>
      toExternalToolDefinition(tool, runtimeScope, group.scope_id),
    ),
  );
  if (tools.length > 0) {
    registerExternalTools(tools);
    if (controllerSocket) {
      for (const tool of tools) {
        if (tool.registrationKey) {
          controllerByRegistrationKey.set(tool.registrationKey, {
            runtime,
            socket: controllerSocket,
          });
        }
      }
    }
    registeredTools.set(runtimeKey, tools);
  } else {
    registeredTools.delete(runtimeKey);
  }
}

export function handleExternalToolCallResponseCommand(
  runtime: ListenerRuntime,
  command: ExternalToolCallResponseCommand,
  sourceSocket?: WebSocket,
): boolean {
  const pending = getPendingExternalToolCalls(runtime).get(command.request_id);
  if (!pending) {
    return false;
  }
  if (
    sourceSocket &&
    pending.controllerSocket &&
    pending.controllerSocket !== sourceSocket
  ) {
    return false;
  }

  clearTimeout(pending.timeout);
  getPendingExternalToolCalls(runtime).delete(command.request_id);

  if (command.error !== undefined) {
    pending.reject(new Error(command.error));
    return true;
  }

  if (command.result === undefined) {
    pending.reject(new Error("External tool response missing result"));
    return true;
  }

  pending.resolve(command.result);
  return true;
}

export function rejectPendingExternalToolCalls(
  runtime: ListenerRuntime,
  reason: string,
): void {
  const pendingExternalToolCalls = getPendingExternalToolCalls(runtime);
  for (const [requestId, pending] of pendingExternalToolCalls) {
    clearTimeout(pending.timeout);
    pendingExternalToolCalls.delete(requestId);
    pending.reject(new Error(reason));
  }

  const registeredTools = registeredToolsByRuntime.get(runtime);
  if (registeredTools) {
    for (const tools of registeredTools.values()) {
      unregisterExternalTools(tools);
      for (const tool of tools) {
        if (
          tool.registrationKey &&
          controllerByRegistrationKey.get(tool.registrationKey)?.runtime ===
            runtime
        ) {
          controllerByRegistrationKey.delete(tool.registrationKey);
        }
      }
    }
    registeredToolsByRuntime.delete(runtime);
  }
}

export function releaseExternalToolConnection(
  runtime: ListenerRuntime,
  socket: WebSocket,
): void {
  const pendingExternalToolCalls = getPendingExternalToolCalls(runtime);
  for (const [requestId, pending] of pendingExternalToolCalls) {
    if (pending.controllerSocket !== socket) {
      continue;
    }
    clearTimeout(pending.timeout);
    pendingExternalToolCalls.delete(requestId);
    pending.reject(new Error("External tool controller disconnected"));
  }

  const registeredTools = registeredToolsByRuntime.get(runtime);
  if (!registeredTools) {
    return;
  }
  for (const [runtimeKey, tools] of registeredTools) {
    const ownedTools = tools.filter((tool) => {
      if (!tool.registrationKey) {
        return false;
      }
      return (
        controllerByRegistrationKey.get(tool.registrationKey)?.socket === socket
      );
    });
    if (ownedTools.length === 0) {
      continue;
    }
    unregisterExternalTools(ownedTools);
    for (const tool of ownedTools) {
      if (tool.registrationKey) {
        controllerByRegistrationKey.delete(tool.registrationKey);
      }
    }
    registeredTools.delete(runtimeKey);
  }
}
