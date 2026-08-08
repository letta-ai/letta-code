import { createHash } from "node:crypto";
import WebSocket from "ws";
import { getModelInfo } from "@/agent/model";
import { createAppServerClient } from "@/app-server-client";
import { settingsManager } from "@/settings-manager";
import { message_channel } from "@/tools/impl/message-channel";
import type {
  ExecuteCommandResponseMessage,
  ListModelsResponseMessage,
  RuntimeScope,
  UpdateModelResponseMessage,
} from "@/types/app-server-protocol";
import type { WsProtocolCommand, WsProtocolMessage } from "@/types/protocol_v2";
import type {
  ServiceCommandRequest,
  ServiceCommandResponse,
  ServiceEvent,
} from "@/types/service-protocol";
import { createChannelRichDraftStreamer } from "./channel-rich-draft-streamer";
import {
  buildChannelCurrentModelMessage,
  buildChannelCurrentModelUnavailableMessage,
  buildChannelModelListMessage,
  buildChannelModelListUnavailableMessage,
  buildChannelModelUpdatedMessage,
  buildChannelModelUpdateFailedMessage,
} from "./commands";
import { ChannelGateway, type ChannelGatewayDelivery } from "./gateway-core";
import { buildGatewayMessageChannelTool } from "./message-channel-gateway-tool";
import {
  type ChannelsCommand,
  handleChannelsProtocolCommand,
  isDetachedChannelsCommand,
} from "./protocol-command-handler";
import { getChannelRegistry, initializeChannels } from "./registry";
import type { ChannelRestoreAgentScope } from "./restore-scope";
import { createRoutedRuntimeRegistrationRefresher } from "./routed-runtime-registration";
import { subscribeChannelRoutesChanged } from "./routing";
import { handleChannelsSlashCommand } from "./slash-command";
import type {
  ChannelModelPickerData,
  ChannelStartupLogger,
  ChannelTurnSource,
} from "./types";

export interface StartLocalChannelGatewayOptions {
  appServerUrl: string;
  channelNames: string[];
  failOnStartupError?: boolean;
  restoreAgentScope?: ChannelRestoreAgentScope | null;
  logger?: ChannelStartupLogger;
  onDisconnect?: (error: Error) => void;
  onServiceEvent?: (event: ServiceEvent) => void;
}

export interface LocalChannelGatewayHandle {
  close(): Promise<void>;
  executeCommand(
    command: ServiceCommandRequest,
  ): Promise<ServiceCommandResponse>;
}

async function executeChannelServiceCommand(
  command: WsProtocolCommand,
): Promise<WsProtocolMessage[]> {
  if (!isDetachedChannelsCommand(command)) {
    throw new Error(`Unsupported ChannelGateway command: ${command.type}`);
  }
  const responses: WsProtocolMessage[] = [];
  const detachedTasks: Promise<void>[] = [];
  const socket = {} as WebSocket;
  const safeSocketSend = (_socket: WebSocket, payload: unknown): boolean => {
    if (!payload || typeof payload !== "object" || !("type" in payload)) {
      throw new Error("ChannelGateway service emitted an invalid response");
    }
    responses.push(payload as WsProtocolMessage);
    return true;
  };
  const runDetachedListenerTask = (
    _commandName: string,
    task: () => Promise<void>,
  ): void => {
    detachedTasks.push(task());
  };
  await handleChannelsProtocolCommand(
    command as ChannelsCommand,
    socket,
    runDetachedListenerTask,
    safeSocketSend,
  );
  await Promise.all(detachedTasks);
  return responses;
}

async function executeGatewayServiceCommand(
  request: ServiceCommandRequest,
): Promise<ServiceCommandResponse> {
  if (request.kind === "protocol") {
    return {
      kind: "protocol",
      messages: await executeChannelServiceCommand(request.command),
    };
  }
  return {
    kind: "text",
    text: await handleChannelsSlashCommand(request.runtime, request.args),
  };
}

function gatewayClientMessageId(delivery: {
  route: { agentId: string; conversationId: string };
  turnSources?: ChannelTurnSource[];
  content: unknown;
}): string {
  const sourceIdentity = (delivery.turnSources ?? [])
    .map((source) => ({
      channel: source.channel,
      accountId: source.accountId ?? null,
      chatId: source.chatId,
      threadId: source.threadId ?? null,
      messageId: source.messageId ?? null,
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const hasPlatformMessageId = (delivery.turnSources ?? []).some((source) =>
    Boolean(source.messageId),
  );
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        agentId: delivery.route.agentId,
        conversationId: delivery.route.conversationId,
        sources: sourceIdentity,
        ...(!hasPlatformMessageId ? { content: delivery.content } : {}),
      }),
    )
    .digest("hex")
    .slice(0, 32);
  return `cm-channel-${digest}`;
}

function isListModelsResponse(
  message: unknown,
): message is ListModelsResponseMessage {
  return (
    !!message &&
    typeof message === "object" &&
    (message as { type?: unknown }).type === "list_models_response"
  );
}

function isUpdateModelResponse(
  message: unknown,
): message is UpdateModelResponseMessage {
  return (
    !!message &&
    typeof message === "object" &&
    (message as { type?: unknown }).type === "update_model_response"
  );
}

function isExecuteCommandResponse(
  message: unknown,
): message is ExecuteCommandResponseMessage {
  return (
    !!message &&
    typeof message === "object" &&
    (message as { type?: unknown }).type === "execute_command_response"
  );
}

export async function startLocalChannelGateway(
  options: StartLocalChannelGatewayOptions,
): Promise<LocalChannelGatewayHandle> {
  await settingsManager.initialize();
  const client = createAppServerClient({
    url: options.appServerUrl,
    WebSocket: WebSocket as never,
  });
  await client.connect();
  let serverInfo: Awaited<ReturnType<typeof client.info>>;
  try {
    serverInfo = await client.info();
  } catch (error) {
    client.close();
    throw error;
  }
  if (serverInfo.capabilities.runtime_external_tools_update !== true) {
    client.close();
    throw new Error(
      "ChannelGateway requires App Server runtime external-tool updates",
    );
  }
  client.onDisconnect(() => {
    options.onDisconnect?.(
      new Error("Channel gateway lost App Server connection"),
    );
  });

  try {
    await initializeChannels(options.channelNames, {
      failOnStartupError: options.failOnStartupError,
      restoreAgentScope: options.restoreAgentScope,
      logger: options.logger,
    });
  } catch (error) {
    client.close();
    throw error;
  }
  const registry = getChannelRegistry();
  if (!registry) {
    client.close();
    throw new Error("Channel registry did not initialize");
  }

  let gateway: ChannelGateway;
  gateway = new ChannelGateway(client, {
    createRichDraft: ({ batchId, sources }) => {
      const streamer = createChannelRichDraftStreamer({ batchId, sources });
      return streamer
        ? {
            handleDelta: (delta) => {
              streamer.handleChunk(
                delta as unknown as import("@letta-ai/letta-client/resources/agents/messages").LettaStreamingResponse,
              );
            },
            flushPending: () => streamer.flushPending(),
            dispose: () => streamer.dispose(),
          }
        : null;
    },
    buildExternalTool: async (runtime) => {
      return buildGatewayMessageChannelTool(
        registry.resolveTurnSourcesForScope(
          runtime.agent_id,
          runtime.conversation_id,
        ),
      );
    },
    executeExternalTool: async (request, sources, idempotencyScope) => {
      if (request.tool_name !== "MessageChannel" || !request.runtime) {
        throw new Error(`Unsupported gateway tool: ${request.tool_name}`);
      }
      const text = await message_channel(
        {
          ...request.input,
          channel: String(request.input.channel ?? ""),
          action: String(request.input.action ?? ""),
          parentScope: {
            agentId: request.runtime.agent_id,
            conversationId: request.runtime.conversation_id,
          },
          channelTurnSources: sources,
        },
        idempotencyScope,
      );
      return {
        content: [{ type: "text", text }],
        is_error: text.startsWith("Error:"),
      };
    },
    onLifecycle: (event) => registry.dispatchTurnLifecycleEvent(event),
    onProgress: (event) => registry.dispatchTurnProgressEvent(event),
    onControlRequest: (event) => registry.registerPendingControlRequest(event),
  });

  const routedRuntimeRegistrationRefresher =
    createRoutedRuntimeRegistrationRefresher({
      registry,
      channelNames: options.channelNames,
      buildTool: buildGatewayMessageChannelTool,
      publisher: {
        getKnownRuntimes: () => gateway.getKnownRuntimes(),
        publish: (updates, routedSources) =>
          gateway.updateRoutedRuntimeTools(updates, routedSources),
      },
      logger: options.logger,
    });
  registry.setMessageHandler((delivery) => {
    const sources = delivery.turnSources ?? [];
    const gatewayDelivery: ChannelGatewayDelivery = {
      runtime: {
        agent_id: delivery.route.agentId,
        conversation_id: delivery.route.conversationId,
      },
      content: delivery.content,
      sources,
      clientMessageId: gatewayClientMessageId(delivery),
      ...(delivery.defaultPermissionMode
        ? { defaultPermissionMode: delivery.defaultPermissionMode }
        : {}),
    };
    void gateway
      .submit(gatewayDelivery)
      .then((accepted) => {
        if (!accepted) {
          options.logger?.("[ChannelGateway] Harness rejected channel input");
        }
      })
      .catch((error) => {
        options.logger?.(
          `[ChannelGateway] Failed to submit input: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  });

  registry.setApprovalResponseHandler(({ runtime, response }) => {
    if (!runtime.agent_id || !runtime.conversation_id) {
      return Promise.resolve(false);
    }
    return gateway.submitApprovalResponse(
      {
        agent_id: runtime.agent_id,
        conversation_id: runtime.conversation_id,
      },
      response,
    );
  });

  registry.setEventHandler((event) => {
    if (event.type === "pairings_updated") {
      options.onServiceEvent?.({
        kind: "protocol",
        message: {
          type: "channel_pairings_updated",
          timestamp: Date.now(),
          channel_id: event.channelId,
        },
      });
      options.onServiceEvent?.({
        kind: "protocol",
        message: {
          type: "channels_updated",
          timestamp: Date.now(),
          channel_id: event.channelId,
        },
      });
      return;
    }
    if (event.type === "targets_updated") {
      options.onServiceEvent?.({
        kind: "protocol",
        message: {
          type: "channel_targets_updated",
          timestamp: Date.now(),
          channel_id: event.channelId,
        },
      });
      options.onServiceEvent?.({
        kind: "protocol",
        message: {
          type: "channels_updated",
          timestamp: Date.now(),
          channel_id: event.channelId,
        },
      });
      return;
    }
    if (event.type === "channel_account_state_updated") {
      routedRuntimeRegistrationRefresher.requestRefresh();
      options.onServiceEvent?.({
        kind: "protocol",
        message: {
          type: "channel_accounts_updated",
          timestamp: Date.now(),
          channel_id: event.channelId,
          account_id: event.accountId,
        },
      });
      options.onServiceEvent?.({
        kind: "protocol",
        message: {
          type: "channels_updated",
          timestamp: Date.now(),
          channel_id: event.channelId,
        },
      });
      return;
    }
    void gateway
      .registerRuntime(
        {
          agent_id: event.agentId,
          conversation_id: event.conversationId,
        },
        registry.resolveTurnSourcesForScope(
          event.agentId,
          event.conversationId,
        ),
        event.defaultPermissionMode,
      )
      .catch((error) => {
        options.logger?.(
          `[ChannelGateway] Failed to register runtime: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  });

  const pendingControlRequests = registry.getPendingControlRequests();
  const recoveredByRuntime = new Map<
    string,
    {
      runtime: RuntimeScope;
      sources: ChannelTurnSource[];
      requestIds: string[];
    }
  >();
  for (const pending of pendingControlRequests) {
    const runtime = {
      agent_id: pending.event.source.agentId,
      conversation_id: pending.event.source.conversationId,
    };
    const key = `${runtime.agent_id}:${runtime.conversation_id}`;
    const recovered = recoveredByRuntime.get(key);
    if (recovered) {
      recovered.sources.push(pending.event.source);
      recovered.requestIds.push(pending.event.requestId);
    } else {
      recoveredByRuntime.set(key, {
        runtime,
        sources: [pending.event.source],
        requestIds: [pending.event.requestId],
      });
    }
  }
  for (const recovered of recoveredByRuntime.values()) {
    const replayedRequestIds = await gateway.restoreRuntime(
      recovered.runtime,
      recovered.sources,
    );
    for (const requestId of recovered.requestIds) {
      if (!replayedRequestIds.has(requestId)) {
        registry.clearPendingControlRequest(requestId);
      }
    }
  }
  await routedRuntimeRegistrationRefresher.refresh();
  const unsubscribeRouteChanges = subscribeChannelRoutesChanged(() => {
    routedRuntimeRegistrationRefresher.requestRefresh();
  });

  registry.setCancelHandler(async ({ runtime }) => {
    const response = await client.abort({ runtime, run_id: null });
    return response.success && response.aborted;
  });

  registry.setModelHandler(async ({ channelId, runtime, modelIdentifier }) => {
    if (!modelIdentifier) {
      try {
        let current = gateway.getModelStatus(runtime);
        if (!current) {
          await gateway.registerRuntime(
            runtime,
            registry.resolveTurnSourcesForScope(
              runtime.agent_id,
              runtime.conversation_id,
            ),
          );
          current = gateway.getModelStatus(runtime);
        }
        if (!current) throw new Error("Runtime model status is unavailable");
        const status = {
          ...current,
          modelLabel:
            (current.modelHandle && getModelInfo(current.modelHandle)?.label) ||
            current.modelHandle ||
            "unknown",
        };
        const listResponse = await client.request<ListModelsResponseMessage>(
          {
            type: "list_models",
            request_id: client.nextRequestId("channel-models"),
          },
          { predicate: isListModelsResponse },
        );
        const modelPicker: ChannelModelPickerData | undefined =
          listResponse.success
            ? {
                current: status,
                entries: listResponse.entries,
                availableHandles: listResponse.available_handles,
                recentHandles: settingsManager.getRecentModels(),
              }
            : undefined;
        return {
          handled: true,
          text: buildChannelCurrentModelMessage(channelId, status),
          ...(modelPicker ? { modelPicker } : {}),
        };
      } catch (error) {
        return {
          handled: true,
          text: buildChannelCurrentModelUnavailableMessage(
            channelId,
            error instanceof Error ? error.message : String(error),
          ),
        };
      }
    }

    if (modelIdentifier.toLowerCase() === "list") {
      const response = await client.request<ListModelsResponseMessage>(
        {
          type: "list_models",
          request_id: client.nextRequestId("channel-model-list"),
        },
        { predicate: isListModelsResponse },
      );
      return {
        handled: true,
        text: response.success
          ? buildChannelModelListMessage(channelId, {
              entries: response.entries,
              availableHandles: response.available_handles,
              recentHandles: settingsManager.getRecentModels(),
            })
          : buildChannelModelListUnavailableMessage(
              channelId,
              response.error ?? "Failed to list models",
            ),
      };
    }

    const response = await client.request<UpdateModelResponseMessage>(
      {
        type: "update_model",
        request_id: client.nextRequestId("channel-model-update"),
        runtime,
        payload: {
          model_id: modelIdentifier,
          model_handle: modelIdentifier,
        },
      },
      { predicate: isUpdateModelResponse },
    );
    if (!response.success) {
      return {
        handled: true,
        text: buildChannelModelUpdateFailedMessage(
          channelId,
          modelIdentifier,
          response.error ?? "Failed to update model",
        ),
      };
    }
    settingsManager.addRecentModel(response.model_handle ?? modelIdentifier);
    gateway.updateModelStatus(
      runtime,
      response.model_handle ?? modelIdentifier,
    );
    return {
      handled: true,
      text: buildChannelModelUpdatedMessage(channelId, {
        modelLabel:
          getModelInfo(response.model_handle ?? modelIdentifier)?.label ??
          modelIdentifier,
        modelHandle: response.model_handle ?? modelIdentifier,
        appliedTo: response.applied_to,
      }),
    };
  });

  const executeRemoteCommand = (
    runtime: RuntimeScope,
    commandId: "reload" | "reflect",
  ): Promise<ExecuteCommandResponseMessage> =>
    client.request<ExecuteCommandResponseMessage>(
      {
        type: "execute_command",
        request_id: client.nextRequestId(`channel-${commandId}`),
        runtime,
        command_id: commandId,
      },
      { predicate: isExecuteCommandResponse },
    );
  registry.setReloadHandler(async ({ runtime }) => {
    const response = await executeRemoteCommand(runtime, "reload");
    return { handled: true, text: response.output };
  });
  registry.setReflectionHandler(async ({ runtime }) => {
    const response = await executeRemoteCommand(runtime, "reflect");
    return { handled: true, text: response.output };
  });

  registry.setReady();
  return {
    executeCommand: async (command) => {
      let result: Awaited<ReturnType<typeof executeGatewayServiceCommand>>;
      try {
        result = await executeGatewayServiceCommand(command);
      } catch (error) {
        routedRuntimeRegistrationRefresher.requestRefresh();
        throw error;
      }
      try {
        await routedRuntimeRegistrationRefresher.refresh();
      } catch (error) {
        options.logger?.(
          `[ChannelGateway] Failed to refresh routed runtimes after service command; retrying: ${error instanceof Error ? error.message : String(error)}`,
        );
        routedRuntimeRegistrationRefresher.requestRefresh();
      }
      return result;
    },
    close: async () => {
      unsubscribeRouteChanges();
      routedRuntimeRegistrationRefresher.close();
      try {
        await registry.stopAll();
      } finally {
        gateway.close();
      }
    },
  };
}
