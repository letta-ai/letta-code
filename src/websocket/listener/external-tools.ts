import type { ListenerExternalToolNotificationGuard } from "@/tools/external-tool-background-eligibility";
import { enableListenerExternalToolBackground } from "@/tools/external-tool-background-eligibility";
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
  RuntimeToolPolicy,
} from "@/types/protocol_v2";
import { debugLog } from "@/utils/debug";
import { createConnectionRequestKey } from "@/websocket/listener/connection";
import { getConversationRuntimeKey } from "@/websocket/listener/runtime";
import { isListenerTransportOpen } from "@/websocket/listener/transport";
import type {
  ListenerConnectionId,
  ListenerConnectionState,
  ListenerRuntime,
} from "@/websocket/listener/types";

const EXTERNAL_TOOL_CALL_TIMEOUT_MS = 5 * 60 * 1000;
/** One connection's tools and tool policy for one conversation. */
interface RuntimeToolRegistration {
  connectionId: ListenerConnectionId;
  runtimeKey: string;
  tools: ExternalToolDefinition[];
  toolPolicy?: RuntimeToolPolicy;
  /** Monotonic registration order; the newest registration wins ties. */
  sequence: number;
}

// Listener-level so conversation-runtime eviction keeps registrations alive.
const registeredToolsByRuntime = new WeakMap<
  ListenerRuntime,
  Map<string, RuntimeToolRegistration>
>();
const lastSubmittingConnectionByRuntime = new WeakMap<
  ListenerRuntime,
  Map<string, ListenerConnectionId>
>();
let nextRegistrationSequence = 0;
const connectionIdByRegistrationKey = new WeakMap<
  ListenerRuntime,
  Map<string, ListenerConnectionId>
>();

export function createExternalToolNotificationState(): Pick<
  ListenerRuntime,
  | "externalToolNotificationEpochByConversation"
  | "externalToolNotificationBarrierByConversation"
> {
  return {
    externalToolNotificationEpochByConversation: new Map(),
    externalToolNotificationBarrierByConversation: new Map(),
  };
}

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

function getLastSubmittingConnections(runtime: ListenerRuntime) {
  let connections = lastSubmittingConnectionByRuntime.get(runtime);
  if (!connections) {
    connections = new Map();
    lastSubmittingConnectionByRuntime.set(runtime, connections);
  }
  return connections;
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
  toolName: string,
): string {
  return JSON.stringify([
    "runtime",
    connectionId,
    runtime.agent_id,
    runtime.conversation_id,
    toolName,
  ]);
}

export function captureExternalToolNotificationGuard(
  listener: ListenerRuntime,
  runtimeScope: RuntimeScope<string | null>,
): ListenerExternalToolNotificationGuard | undefined {
  if (listener.intentionallyClosed || !listener.processServicesStarted) {
    return undefined;
  }
  const processServicesGeneration = listener.processServicesGeneration;
  const runtimeKey = getConversationRuntimeKey(
    runtimeScope.agent_id,
    runtimeScope.conversation_id,
  );
  const notificationEpoch =
    listener.externalToolNotificationEpochByConversation.get(runtimeKey) ?? 0;
  const isCurrent = () =>
    !listener.intentionallyClosed &&
    listener.processServicesStarted &&
    listener.processServicesGeneration === processServicesGeneration &&
    (listener.externalToolNotificationEpochByConversation.get(runtimeKey) ??
      0) === notificationEpoch;
  return {
    isCurrent,
    waitUntilCurrent: async () => {
      while (true) {
        const pending =
          listener.externalToolNotificationBarrierByConversation.get(
            runtimeKey,
          );
        if (!pending) return isCurrent();
        await pending;
        if (
          listener.externalToolNotificationBarrierByConversation.get(
            runtimeKey,
          ) === pending
        ) {
          return isCurrent();
        }
      }
    },
  };
}

function toExternalToolDefinition(
  listener: ListenerRuntime,
  tool: ExternalToolDefinitionPayload,
  connectionId: ListenerConnectionId,
  runtimeScope: RuntimeScope<string | null>,
): ExternalToolDefinition {
  const toolDefinition: ExternalToolDefinition = {
    name: tool.name,
    connectionId,
    ...(tool.label !== undefined ? { label: tool.label } : {}),
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.timeout_ms !== undefined ? { timeoutMs: tool.timeout_ms } : {}),
    autoBackground: tool.auto_background ?? true,
    registrationKey: getToolRegistrationKey(
      connectionId,
      runtimeScope,
      tool.name,
    ),
    runtime: {
      agentId: runtimeScope.agent_id ?? undefined,
      conversationId: runtimeScope.conversation_id,
    },
  };
  return enableListenerExternalToolBackground(toolDefinition, {
    createNotificationGuard: () =>
      captureExternalToolNotificationGuard(listener, runtimeScope),
  });
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
      throw new Error(
        "External tool controller is not connected; the tool call was not sent and is safe to retry.",
      );
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
    const conversation = requestRuntime
      ? runtime.conversationRuntimes?.get(
          getConversationRuntimeKey(
            requestRuntime.agent_id,
            requestRuntime.conversation_id,
          ),
        )
      : null;
    const lease = conversation?.turnLifecycle.currentLease;
    const isOwningTurnCurrent =
      conversation && lease
        ? () =>
            conversation.turnLifecycle.isCurrent(lease) && !lease.signal.aborted
        : undefined;
    const request: ExternalToolCallRequestMessage = {
      type: "external_tool_call_request",
      request_id: requestId,
      ...(requestRuntime ? { runtime: requestRuntime } : {}),
      tool_call_id: toolCallId,
      tool_name: toolName,
      input,
    };

    const requestFrame = JSON.stringify(request);
    const timeoutMs = context?.tool.timeoutMs ?? EXTERNAL_TOOL_CALL_TIMEOUT_MS;
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
        reject(
          new Error(
            `External tool call timed out after ${Math.ceil(timeoutMs / 1_000)}s: ${toolName}. The remote tool may still finish; its outcome is unknown. Check the destination before retrying a write.`,
          ),
        );
      }, timeoutMs);

      getPendingExternalToolCalls(runtime).set(requestKey, {
        connectionId: connection.id,
        isOwningTurnCurrent,
        requestFrame,
        sentOn: writer,
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
        writer.send(requestFrame);
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
  toolPolicy?: RuntimeToolPolicy,
): void {
  const resolvedGroups = groups ?? [];
  if (resolvedGroups.some((group) => Object.hasOwn(group, "scope_id"))) {
    debugLog("Listen", "Ignoring deprecated external tool scope_id");
  }
  const registeredTools = getRegisteredTools(runtime);
  const runtimeKey = getRuntimeKey(runtimeScope);
  const registrationScope = createConnectionRequestKey(
    connectionId,
    runtimeKey,
  );
  const previousTools = registeredTools.get(registrationScope)?.tools ?? [];
  unregisterExternalTools(previousTools);

  const tools = resolvedGroups.flatMap((group) =>
    group.tools.map((tool) =>
      toExternalToolDefinition(runtime, tool, connectionId, runtimeScope),
    ),
  );
  const controllers = getConnectionIdsByRegistrationKey(runtime);
  for (const tool of previousTools) {
    if (tool.registrationKey) {
      controllers.delete(tool.registrationKey);
    }
  }
  registerExternalTools(tools);
  for (const tool of tools) {
    if (tool.registrationKey) {
      controllers.set(tool.registrationKey, connectionId);
    }
  }
  // Delete first so a replacement moves to the end in registration order.
  registeredTools.delete(registrationScope);
  if (tools.length > 0 || toolPolicy !== undefined) {
    registeredTools.set(registrationScope, {
      connectionId,
      runtimeKey,
      tools,
      ...(toolPolicy !== undefined ? { toolPolicy } : {}),
      sequence: ++nextRegistrationSequence,
    });
  }
}

/** Remember which connection last submitted input on a runtime. */
export function recordRuntimeSubmittingConnection(
  runtime: ListenerRuntime,
  runtimeScope: RuntimeScope<string | null>,
  connectionId: ListenerConnectionId,
): void {
  getLastSubmittingConnections(runtime).set(
    getRuntimeKey(runtimeScope),
    connectionId,
  );
}

/**
 * Pick the connection whose registration shapes a turn's tools. A client turn
 * uses its own connection. A turn the process started (task notification,
 * cron, recovery) uses the last connection that submitted input on this
 * runtime if it still has a registration here, else the newest registration.
 */
export function resolveRuntimeToolOwner(
  runtime: ListenerRuntime,
  runtimeScope: RuntimeScope<string | null>,
  submittingConnectionId?: ListenerConnectionId,
): { connectionId?: ListenerConnectionId; toolPolicy?: RuntimeToolPolicy } {
  const registeredTools = registeredToolsByRuntime.get(runtime);
  const runtimeKey = getRuntimeKey(runtimeScope);
  const registrationFor = (connectionId: ListenerConnectionId) =>
    registeredTools?.get(createConnectionRequestKey(connectionId, runtimeKey));
  if (submittingConnectionId !== undefined) {
    const toolPolicy = registrationFor(submittingConnectionId)?.toolPolicy;
    return {
      connectionId: submittingConnectionId,
      ...(toolPolicy ? { toolPolicy } : {}),
    };
  }
  const lastSubmitter = lastSubmittingConnectionByRuntime
    .get(runtime)
    ?.get(runtimeKey);
  let owner =
    lastSubmitter !== undefined ? registrationFor(lastSubmitter) : undefined;
  if (!owner) {
    for (const registration of registeredTools?.values() ?? []) {
      if (
        registration.runtimeKey === runtimeKey &&
        (!owner || registration.sequence > owner.sequence)
      ) {
        owner = registration;
      }
    }
  }
  if (!owner) return {};
  return {
    connectionId: owner.connectionId,
    ...(owner.toolPolicy ? { toolPolicy: owner.toolPolicy } : {}),
  };
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
        update.tool_policy,
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

/**
 * Resend requests still awaiting a response after the connection's socket was
 * replaced. A transient close (e.g. code 1001) can drop a frame that was
 * written just before it; without a resend the call waits out its timeout.
 * The server dedupes by request_id, so a request that did arrive is not
 * executed twice.
 */
export function resendPendingExternalToolCallsForConnection(
  runtime: ListenerRuntime,
  connection: Pick<ListenerConnectionState, "id" | "writer">,
): void {
  const pendingExternalToolCalls = getPendingExternalToolCalls(runtime);
  for (const [requestKey, pending] of pendingExternalToolCalls) {
    if (
      pending.connectionId !== connection.id ||
      pending.sentOn === connection.writer
    ) {
      continue;
    }
    try {
      if (pending.isOwningTurnCurrent && !pending.isOwningTurnCurrent()) {
        throw new Error(
          "External tool call was not resent because its owning turn is no longer active.",
        );
      }
      connection.writer.send(pending.requestFrame);
      pending.sentOn = connection.writer;
    } catch (error) {
      clearTimeout(pending.timeout);
      pendingExternalToolCalls.delete(requestKey);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
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

  const lastSubmitters = lastSubmittingConnectionByRuntime.get(runtime);
  for (const [runtimeKey, submitter] of lastSubmitters ?? []) {
    if (submitter === connectionId) lastSubmitters?.delete(runtimeKey);
  }
  const registeredTools = registeredToolsByRuntime.get(runtime);
  if (!registeredTools) {
    return;
  }
  const controllers = getConnectionIdsByRegistrationKey(runtime);
  for (const [registrationScope, registration] of registeredTools) {
    if (registration.connectionId !== connectionId) {
      continue;
    }
    unregisterExternalTools(registration.tools);
    registeredTools.delete(registrationScope);
    for (const tool of registration.tools) {
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
    for (const registration of registeredTools.values()) {
      unregisterExternalTools(registration.tools);
    }
    registeredToolsByRuntime.delete(runtime);
  }
  connectionIdByRegistrationKey.delete(runtime);
  lastSubmittingConnectionByRuntime.delete(runtime);
}
