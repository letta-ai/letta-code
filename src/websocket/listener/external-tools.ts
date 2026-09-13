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
  RuntimeExternalToolsUpdateGroup,
  RuntimeScope,
  RuntimeStartExternalToolsGroup,
} from "@/types/protocol_v2";
import { createConnectionRequestKey } from "@/websocket/listener/connection";
import { isListenerTransportOpen } from "@/websocket/listener/transport";
import type {
  ListenerConnectionId,
  ListenerRuntime,
} from "@/websocket/listener/types";

const EXTERNAL_TOOL_CALL_TIMEOUT_MS = 5 * 60 * 1000;
const registeredToolsByRuntime = new WeakMap<
  ListenerRuntime,
  Map<string, ExternalToolDefinition[]>
>();
const connectionIdByRegistrationKey = new WeakMap<
  ListenerRuntime,
  Map<string, ListenerConnectionId>
>();

function getPendingExternalToolCalls(runtime: ListenerRuntime) {
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

function getConnectionIdsByRegistrationKey(runtime: ListenerRuntime) {
  let controllers = connectionIdByRegistrationKey.get(runtime);
  if (!controllers) {
    controllers = new Map();
    connectionIdByRegistrationKey.set(runtime, controllers);
  }
  return controllers;
}

function getRuntimeKey(runtime: RuntimeScope<string | null>): string {
  return `${runtime.agent_id}:${runtime.conversation_id}`;
}

function getToolRegistrationKey(
  connectionId: ListenerConnectionId,
  runtime: RuntimeScope<string | null>,
  scopeId: string | undefined,
  toolName: string,
): string {
  return JSON.stringify([
    "runtime",
    connectionId,
    runtime.agent_id,
    runtime.conversation_id,
    scopeId ?? null,
    toolName,
  ]);
}

function toExternalToolDefinition(
  tool: ExternalToolDefinitionPayload,
  connectionId: ListenerConnectionId,
  runtime: RuntimeScope<string | null>,
  scopeId?: string,
): ExternalToolDefinition {
  return {
    name: tool.name,
    connectionId,
    ...(tool.label !== undefined ? { label: tool.label } : {}),
    description: tool.description,
    parameters: tool.parameters,
    registrationKey: getToolRegistrationKey(
      connectionId,
      runtime,
      scopeId,
      tool.name,
    ),
    ...(scopeId !== undefined ? { scopeId } : {}),
    runtime: {
      agentId: runtime.agent_id ?? undefined,
      conversationId: runtime.conversation_id,
    },
  };
}

export function installExternalToolBridge(runtime: ListenerRuntime): void {
  setExternalToolExecutor(async (toolCallId, toolName, input, context) => {
    const registrationKey = context?.tool.registrationKey;
    const connectionId = registrationKey
      ? getConnectionIdsByRegistrationKey(runtime).get(registrationKey)
      : undefined;
    const connection = connectionId
      ? runtime.connections.get(connectionId)
      : undefined;
    if (
      !connection ||
      !isListenerTransportOpen(connection.writer) ||
      runtime.intentionallyClosed
    ) {
      throw new Error("External tool controller is not connected");
    }
    const writer = connection.writer;

    const requestId = `external-tool-${crypto.randomUUID()}`;
    const requestKey = createConnectionRequestKey(connection.id, requestId);
    const toolRuntime = context?.tool.runtime;
    const requestRuntime = toolRuntime?.conversationId
      ? {
          agent_id: toolRuntime.agentId ?? null,
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
        getPendingExternalToolCalls(runtime).delete(requestKey);
        reject(new Error(`External tool call timed out: ${toolName}`));
      }, EXTERNAL_TOOL_CALL_TIMEOUT_MS);

      getPendingExternalToolCalls(runtime).set(requestKey, {
        connectionId: connection.id,
        resolve: (response) => {
          resolve({
            content: [...response.content],
            isError: response.is_error === true,
          });
        },
        reject,
        timeout,
      });

      try {
        writer.send(JSON.stringify(request));
      } catch (error) {
        clearTimeout(timeout);
        getPendingExternalToolCalls(runtime).delete(requestKey);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    return result;
  });
}

export function registerRuntimeExternalTools(
  runtime: ListenerRuntime,
  connectionId: ListenerConnectionId,
  runtimeScope: RuntimeScope<string | null>,
  groups?: readonly RuntimeStartExternalToolsGroup[],
): void {
  const resolvedGroups = groups ?? [];
  const registeredTools = getRegisteredTools(runtime);
  const runtimeKey = createConnectionRequestKey(
    connectionId,
    getRuntimeKey(runtimeScope),
  );
  const previousTools = registeredTools.get(runtimeKey) ?? [];
  unregisterExternalTools(previousTools);

  const tools = resolvedGroups.flatMap((group) =>
    group.tools.map((tool) =>
      toExternalToolDefinition(
        tool,
        connectionId,
        runtimeScope,
        group.scope_id,
      ),
    ),
  );
  const controllers = getConnectionIdsByRegistrationKey(runtime);
  for (const tool of previousTools) {
    if (tool.registrationKey) {
      controllers.delete(tool.registrationKey);
    }
  }
  if (tools.length > 0) {
    registerExternalTools(tools);
    for (const tool of tools) {
      if (tool.registrationKey) {
        controllers.set(tool.registrationKey, connectionId);
      }
    }
    registeredTools.set(runtimeKey, tools);
  } else {
    registeredTools.delete(runtimeKey);
  }
}

export function updateRuntimeExternalTools(
  runtime: ListenerRuntime,
  connectionId: ListenerConnectionId,
  updates: readonly RuntimeExternalToolsUpdateGroup[],
): void {
  for (const update of updates) {
    for (const runtimeScope of update.runtimes) {
      registerRuntimeExternalTools(
        runtime,
        connectionId,
        runtimeScope,
        update.external_tools,
      );
    }
  }
}

export function handleExternalToolCallResponseCommand(
  runtime: ListenerRuntime,
  connectionId: ListenerConnectionId,
  command: ExternalToolCallResponseCommand,
): boolean {
  const requestKey = createConnectionRequestKey(
    connectionId,
    command.request_id,
  );
  const pending = getPendingExternalToolCalls(runtime).get(requestKey);
  if (!pending) {
    return false;
  }

  clearTimeout(pending.timeout);
  getPendingExternalToolCalls(runtime).delete(requestKey);

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

export function rejectPendingExternalToolCallsForConnection(
  runtime: ListenerRuntime,
  connectionId: ListenerConnectionId,
  reason: string,
): void {
  const pendingExternalToolCalls = getPendingExternalToolCalls(runtime);
  for (const [requestKey, pending] of pendingExternalToolCalls) {
    if (pending.connectionId !== connectionId) {
      continue;
    }
    clearTimeout(pending.timeout);
    pendingExternalToolCalls.delete(requestKey);
    pending.reject(new Error(reason));
  }

  const registeredTools = registeredToolsByRuntime.get(runtime);
  if (!registeredTools) {
    return;
  }
  const controllers = getConnectionIdsByRegistrationKey(runtime);
  for (const [registrationScope, tools] of registeredTools) {
    const ownedByConnection = tools.some(
      (tool) =>
        tool.registrationKey !== undefined &&
        controllers.get(tool.registrationKey) === connectionId,
    );
    if (!ownedByConnection) {
      continue;
    }
    unregisterExternalTools(tools);
    registeredTools.delete(registrationScope);
    for (const tool of tools) {
      if (tool.registrationKey) {
        controllers.delete(tool.registrationKey);
      }
    }
  }
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
    }
    registeredToolsByRuntime.delete(runtime);
  }
  connectionIdByRegistrationKey.delete(runtime);
}
