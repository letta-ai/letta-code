import type WebSocket from "ws";
import {
  type ExternalToolDefinition,
  registerExternalTools,
  setExternalToolExecutor,
  unregisterExternalTools,
  unregisterExternalToolsForScope,
} from "@/tools/manager";
import type {
  ExternalToolCallRequestMessage,
  ExternalToolCallResponseCommand,
  ExternalToolDefinitionPayload,
  ExternalToolsRegisterCommand,
  ExternalToolsRegisterResponseMessage,
} from "@/types/protocol_v2";
import type { ListenerRuntime } from "@/websocket/listener/types";

const EXTERNAL_TOOL_CALL_TIMEOUT_MS = 5 * 60 * 1000;
const WEBSOCKET_OPEN = 1;
const registeredToolsByRuntime = new WeakMap<
  ListenerRuntime,
  ExternalToolDefinition[]
>();

function isSocketOpen(socket: WebSocket | null): socket is WebSocket {
  return socket?.readyState === WEBSOCKET_OPEN;
}

function getPendingExternalToolCalls(runtime: ListenerRuntime) {
  runtime.pendingExternalToolCalls ??= new Map();
  return runtime.pendingExternalToolCalls;
}

function toExternalToolDefinition(
  tool: ExternalToolDefinitionPayload,
  command: ExternalToolsRegisterCommand,
): ExternalToolDefinition {
  return {
    name: tool.name,
    ...(tool.label !== undefined ? { label: tool.label } : {}),
    description: tool.description,
    parameters: tool.parameters,
    ...(command.scope_id !== undefined ? { scopeId: command.scope_id } : {}),
    ...(command.runtime !== undefined ? { runtime: command.runtime } : {}),
  };
}

function sendJson(socket: WebSocket, payload: unknown): void {
  socket.send(JSON.stringify(payload));
}

export function installExternalToolBridge(runtime: ListenerRuntime): void {
  setExternalToolExecutor(async (toolCallId, toolName, input, context) => {
    const socket = runtime.socket;
    if (!isSocketOpen(socket) || runtime.intentionallyClosed) {
      throw new Error("External tool controller is not connected");
    }

    const requestId = `external-tool-${crypto.randomUUID()}`;
    const request: ExternalToolCallRequestMessage = {
      type: "external_tool_call_request",
      request_id: requestId,
      ...(context?.tool.runtime !== undefined
        ? { runtime: context.tool.runtime }
        : {}),
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
            content: response.content,
            isError: response.is_error === true,
          });
        },
        reject,
        timeout,
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

export function handleExternalToolsRegisterCommand(
  runtime: ListenerRuntime,
  command: ExternalToolsRegisterCommand,
  socket: WebSocket,
): void {
  const tools = command.tools.map((tool) =>
    toExternalToolDefinition(tool, command),
  );
  if (command.scope_id !== undefined) {
    unregisterExternalToolsForScope(command.scope_id);
  }
  registerExternalTools(tools);
  const previousTools = registeredToolsByRuntime.get(runtime) ?? [];
  const nextTools =
    command.scope_id === undefined
      ? [...previousTools, ...tools]
      : [
          ...previousTools.filter((tool) => tool.scopeId !== command.scope_id),
          ...tools,
        ];
  registeredToolsByRuntime.set(runtime, nextTools);

  const response: ExternalToolsRegisterResponseMessage = {
    type: "external_tools_register_response",
    request_id: command.request_id,
    success: true,
    ...(command.scope_id !== undefined ? { scope_id: command.scope_id } : {}),
    tool_names: tools.map((tool) => tool.name),
  };
  sendJson(socket, response);
}

export function handleExternalToolCallResponseCommand(
  runtime: ListenerRuntime,
  command: ExternalToolCallResponseCommand,
): boolean {
  const pending = getPendingExternalToolCalls(runtime).get(command.request_id);
  if (!pending) {
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
    unregisterExternalTools(registeredTools);
    registeredToolsByRuntime.delete(runtime);
  }
}
