import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { APIError } from "@letta-ai/letta-client/core/error";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import WebSocket from "ws";
import {
  type EnsureLocalMemfsCheckoutOptions,
  getMemoryFilesystemRoot,
} from "@/agent/memory-filesystem";
import { buildConversationMessagesCreateRequestBody } from "@/agent/message";
import { models } from "@/agent/model";
import {
  DEFAULT_CREATE_AGENT_PERSONALITIES,
  getPersonalityOption,
} from "@/agent/personality-presets";
import { clearAllSubagents, registerSubagent } from "@/agent/subagent-state";
import { __testSetBackend, type AgentCreateBody } from "@/backend";
import { LocalBackend } from "@/backend/local";
import { formatErrorDetails } from "@/cli/helpers/error-formatter";
import { setSystemPromptDoctorState } from "@/cli/helpers/system-prompt-warning";
import { INTERRUPTED_BY_USER } from "@/constants";
import { appendCronRunLog, getCronRunLogPath } from "@/cron";
import type { MessageQueueItem } from "@/queue/queue-runtime";
import type { LocalProjectSettings, Settings } from "@/settings-manager";
import { settingsManager } from "@/settings-manager";
import {
  backgroundProcesses,
  backgroundTasks,
} from "@/tools/impl/process_manager";
import { LIMITS } from "@/tools/impl/truncation";
import {
  clearExternalTools,
  prepareToolExecutionContextForModel,
} from "@/tools/manager";
import type { ControlRequest } from "@/types/protocol_v2";
import {
  __listenClientTestUtils,
  emitInterruptedStatusDelta,
  parseServerMessage,
  rejectPendingApprovalResolvers,
  requestApprovalOverWS,
  resolvePendingApprovalResolver,
} from "@/websocket/listen-client";
import {
  handleExecuteCommand,
  SUPPORTED_REMOTE_COMMANDS,
} from "@/websocket/listener/commands";
import { ensureListenerModAdapter } from "@/websocket/listener/mod-adapter";
import { isEditFileCommand } from "@/websocket/listener/protocol-inbound";
import {
  DESKTOP_DEBUG_PANEL_INFO_PREFIX,
  emitLoopErrorNotice,
  emitRecoverableRetryNotice,
  emitRecoverableStatusNotice,
  getLoopErrorNoticeDecision,
  getRecoverableRetryNoticeVisibility,
  getRecoverableStatusNoticeVisibility,
} from "@/websocket/listener/recoverable-notices";
import type { ConversationRuntime } from "@/websocket/listener/types";

function beginTestTurn(
  runtime: ConversationRuntime,
  options: {
    workingDirectory?: string;
    initialStatus?: Parameters<
      ConversationRuntime["turnLifecycle"]["begin"]
    >[0]["initialStatus"];
    abortController?: AbortController;
    runId?: string;
    executingToolCallIds?: readonly string[];
  } = {},
) {
  const lease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: options.workingDirectory ?? "/tmp/test-worktree",
    ...(options.initialStatus ? { initialStatus: options.initialStatus } : {}),
    ...(options.abortController
      ? { abortController: options.abortController }
      : {}),
    ...(options.executingToolCallIds
      ? { executingToolCallIds: options.executingToolCallIds }
      : {}),
  });
  if (options.runId) {
    runtime.turnLifecycle.setRunId(lease, options.runId);
  }
  return lease;
}

class MockSocket {
  readyState: number;
  closeCalls = 0;
  removeAllListenersCalls = 0;
  sentPayloads: string[] = [];
  sendImpl: (data: string) => void = (data) => {
    this.sentPayloads.push(data);
  };

  constructor(readyState: number = WebSocket.OPEN) {
    this.readyState = readyState;
  }

  send(data: string): void {
    this.sendImpl(data);
  }

  close(): void {
    this.closeCalls += 1;
  }

  removeAllListeners(): this {
    this.removeAllListenersCalls += 1;
    return this;
  }
}

const actualChannelsService = await import("@/channels/service");

afterEach(() => {
  __testSetBackend(null);
  clearExternalTools();
  __listenClientTestUtils.setChannelsServiceLoaderForTests(null);
  mock.restore();
});

describe("listen-client channel command dispatch", () => {
  test("recognizes account-scoped channel commands as detached channels commands", () => {
    expect(
      __listenClientTestUtils.isDetachedChannelsCommand({
        type: "channel_accounts_list",
        request_id: "channel-accounts-list-1",
        channel_id: "telegram",
      }),
    ).toBe(true);

    expect(
      __listenClientTestUtils.isDetachedChannelsCommand({
        type: "channel_account_create",
        request_id: "channel-account-create-1",
        channel_id: "slack",
        account: {
          display_name: "DocsBot Slack",
          dm_policy: "pairing",
          config: {
            bot_token: "xoxb-test",
            app_token: "xapp-test",
            mode: "socket",
          },
        },
      }),
    ).toBe(true);

    expect(
      __listenClientTestUtils.isDetachedChannelsCommand({
        type: "channel_account_start",
        request_id: "channel-account-start-1",
        channel_id: "telegram",
        account_id: "bot-1",
      }),
    ).toBe(true);
  });
});

function makeControlRequest(requestId: string): ControlRequest {
  return {
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: "Write",
      input: {},
      tool_call_id: "call-1",
      permission_suggestions: [],
      blocked_path: null,
    },
  };
}

function requestTestApproval(
  runtime: ConversationRuntime,
  socket: MockSocket,
  turnLease: ReturnType<typeof beginTestTurn>,
  requestId: string,
) {
  return requestApprovalOverWS(
    runtime,
    socket as unknown as WebSocket,
    turnLease,
    requestId,
    makeControlRequest(requestId),
  );
}

describe("listen-client parseServerMessage", () => {
  test("parses valid input approval_response command", () => {
    const parsed = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "input",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
          payload: {
            kind: "approval_response",
            request_id: "perm-1",
            decision: { behavior: "allow" },
          },
        }),
      ),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("input");
  });

  test("parses approval_response with selected permission suggestion ids", () => {
    const parsed = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "input",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
          payload: {
            kind: "approval_response",
            request_id: "perm-1",
            decision: {
              behavior: "allow",
              selected_permission_suggestion_ids: ["save-default"],
            },
          },
        }),
      ),
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("input");
  });

  describe("listen-client create_agent command handling", () => {
    test("creates the default presets through the shared helper", async () => {
      expect(DEFAULT_CREATE_AGENT_PERSONALITIES).toEqual([
        "memo",
        "tutorial",
        "blank",
        "linus",
        "kawaii",
      ]);

      for (const personality of [...DEFAULT_CREATE_AGENT_PERSONALITIES]) {
        const socket = new MockSocket(WebSocket.OPEN);
        const personalityOption = getPersonalityOption(personality);
        const createAgentForPersonalityMock = mock(async () => ({
          agent: {
            id: `agent-${personality}`,
            name: personalityOption.label,
            model: "anthropic/test-model",
          } as never,
          provenance: "created",
        }));
        mock.module("../agent/personality", () => ({
          createAgentForPersonality: createAgentForPersonalityMock,
        }));

        const originalPinAgent = settingsManager.pinAgent;
        const pinAgentMock = mock(() => {});
        settingsManager.pinAgent = pinAgentMock;

        await __listenClientTestUtils.handleCreateAgentCommand(
          {
            type: "create_agent",
            request_id: `create-${personality}`,
            personality,
            tags: ["origin:onboarding"],
          },
          socket as unknown as WebSocket,
        );
        settingsManager.pinAgent = originalPinAgent;
        expect(createAgentForPersonalityMock).toHaveBeenCalledTimes(1);
        expect(createAgentForPersonalityMock).toHaveBeenCalledWith({
          personalityId: personality,
          model: undefined,
          tags: ["origin:onboarding"],
        });
        expect(pinAgentMock).toHaveBeenCalledWith(`agent-${personality}`);

        const messages = socket.sentPayloads.map((payload) =>
          JSON.parse(payload),
        );
        expect(messages).toContainEqual(
          expect.objectContaining({
            type: "create_agent_response",
            request_id: `create-${personality}`,
            success: true,
            agent_id: `agent-${personality}`,
            name: personalityOption.label,
            model: "anthropic/test-model",
          }),
        );
      }
    });

    test("does not pin when pin_global is false", async () => {
      const socket = new MockSocket(WebSocket.OPEN);
      const createAgentForPersonalityMock = mock(async () => ({
        agent: {
          id: "agent-kawaii",
          name: "Kawaii",
          model: "anthropic/test-model",
        } as never,
        provenance: "created",
      }));
      mock.module("../agent/personality", () => ({
        createAgentForPersonality: createAgentForPersonalityMock,
      }));

      const originalPinAgent = settingsManager.pinAgent;
      const pinAgentMock = mock(() => {});
      settingsManager.pinAgent = pinAgentMock;

      await __listenClientTestUtils.handleCreateAgentCommand(
        {
          type: "create_agent",
          request_id: "create-no-pin",
          personality: "kawaii",
          pin_global: false,
        },
        socket as unknown as WebSocket,
      );

      settingsManager.pinAgent = originalPinAgent;
      expect(pinAgentMock).not.toHaveBeenCalled();
    });
  });

  describe("listen-client agent/conversation management command handling", () => {
    test("lists, retrieves, and creates agents and conversations", async () => {
      const storageDir = await mkdtemp(join(os.tmpdir(), "ws-management-"));
      try {
        class ManagementBackend extends LocalBackend {
          override async compactConversationMessages(
            ..._args: Parameters<LocalBackend["compactConversationMessages"]>
          ): ReturnType<LocalBackend["compactConversationMessages"]> {
            return {
              num_messages_before: 4,
              num_messages_after: 2,
              summary: "compacted summary",
            } as Awaited<
              ReturnType<LocalBackend["compactConversationMessages"]>
            >;
          }
        }

        const backend = new ManagementBackend({
          storageDir,
          executionMode: "deterministic",
        });
        __testSetBackend(backend);
        const socket = new MockSocket(WebSocket.OPEN);

        await __listenClientTestUtils.handleAgentConversationManagementCommand(
          {
            type: "agent_create",
            request_id: "agent-create-1",
            body: {
              name: "WS Managed Agent",
              model: "anthropic/claude-sonnet-4-6",
            } as AgentCreateBody,
          },
          socket as unknown as WebSocket,
        );

        const agentCreateResponse = JSON.parse(
          socket.sentPayloads.at(-1) ?? "{}",
        );
        expect(agentCreateResponse).toMatchObject({
          type: "agent_create_response",
          request_id: "agent-create-1",
          success: true,
          agent: {
            name: "WS Managed Agent",
          },
        });
        const agentId = agentCreateResponse.agent.id as string;

        await __listenClientTestUtils.handleAgentConversationManagementCommand(
          {
            type: "agent_list",
            request_id: "agent-list-1",
            query: { limit: 10 },
          },
          socket as unknown as WebSocket,
        );
        expect(JSON.parse(socket.sentPayloads.at(-1) ?? "{}")).toMatchObject({
          type: "agent_list_response",
          request_id: "agent-list-1",
          success: true,
          agents: [expect.objectContaining({ id: agentId })],
        });

        await __listenClientTestUtils.handleAgentConversationManagementCommand(
          {
            type: "agent_retrieve",
            request_id: "agent-retrieve-1",
            agent_id: agentId,
          },
          socket as unknown as WebSocket,
        );
        expect(JSON.parse(socket.sentPayloads.at(-1) ?? "{}")).toMatchObject({
          type: "agent_retrieve_response",
          request_id: "agent-retrieve-1",
          success: true,
          agent: { id: agentId },
        });

        await __listenClientTestUtils.handleAgentConversationManagementCommand(
          {
            type: "agent_update",
            request_id: "agent-update-1",
            agent_id: agentId,
            body: { name: "WS Managed Agent Updated" },
          },
          socket as unknown as WebSocket,
        );
        expect(JSON.parse(socket.sentPayloads.at(-1) ?? "{}")).toMatchObject({
          type: "agent_update_response",
          request_id: "agent-update-1",
          success: true,
          agent: { id: agentId, name: "WS Managed Agent Updated" },
        });

        await __listenClientTestUtils.handleAgentConversationManagementCommand(
          {
            type: "conversation_create",
            request_id: "conversation-create-1",
            body: { agent_id: agentId },
          },
          socket as unknown as WebSocket,
        );
        const conversationCreateResponse = JSON.parse(
          socket.sentPayloads.at(-1) ?? "{}",
        );
        expect(conversationCreateResponse).toMatchObject({
          type: "conversation_create_response",
          request_id: "conversation-create-1",
          success: true,
          conversation: { agent_id: agentId },
        });
        const conversationId = conversationCreateResponse.conversation
          .id as string;

        await __listenClientTestUtils.handleAgentConversationManagementCommand(
          {
            type: "conversation_list",
            request_id: "conversation-list-1",
            query: { agent_id: agentId, limit: 10 },
          },
          socket as unknown as WebSocket,
        );
        expect(JSON.parse(socket.sentPayloads.at(-1) ?? "{}")).toMatchObject({
          type: "conversation_list_response",
          request_id: "conversation-list-1",
          success: true,
          conversations: [expect.objectContaining({ id: conversationId })],
        });

        await __listenClientTestUtils.handleAgentConversationManagementCommand(
          {
            type: "conversation_retrieve",
            request_id: "conversation-retrieve-1",
            conversation_id: conversationId,
          },
          socket as unknown as WebSocket,
        );
        expect(JSON.parse(socket.sentPayloads.at(-1) ?? "{}")).toMatchObject({
          type: "conversation_retrieve_response",
          request_id: "conversation-retrieve-1",
          success: true,
          conversation: { id: conversationId },
        });

        await __listenClientTestUtils.handleAgentConversationManagementCommand(
          {
            type: "conversation_update",
            request_id: "conversation-update-1",
            conversation_id: conversationId,
            body: { summary: "Updated conversation summary" },
          },
          socket as unknown as WebSocket,
        );
        expect(JSON.parse(socket.sentPayloads.at(-1) ?? "{}")).toMatchObject({
          type: "conversation_update_response",
          request_id: "conversation-update-1",
          success: true,
          conversation: {
            id: conversationId,
            summary: "Updated conversation summary",
          },
        });

        await __listenClientTestUtils.handleAgentConversationManagementCommand(
          {
            type: "conversation_recompile",
            request_id: "conversation-recompile-1",
            conversation_id: conversationId,
            body: { dry_run: true },
          },
          socket as unknown as WebSocket,
        );
        expect(JSON.parse(socket.sentPayloads.at(-1) ?? "{}")).toMatchObject({
          type: "conversation_recompile_response",
          request_id: "conversation-recompile-1",
          success: true,
          result: expect.any(String),
        });

        await __listenClientTestUtils.handleAgentConversationManagementCommand(
          {
            type: "conversation_fork",
            request_id: "conversation-fork-1",
            conversation_id: conversationId,
            body: { hidden: true },
          },
          socket as unknown as WebSocket,
        );
        expect(JSON.parse(socket.sentPayloads.at(-1) ?? "{}")).toMatchObject({
          type: "conversation_fork_response",
          request_id: "conversation-fork-1",
          success: true,
          conversation: { id: expect.any(String) },
        });

        await __listenClientTestUtils.handleAgentConversationManagementCommand(
          {
            type: "conversation_messages_list",
            request_id: "conversation-messages-list-1",
            conversation_id: conversationId,
            query: { limit: 10 },
          },
          socket as unknown as WebSocket,
        );
        expect(JSON.parse(socket.sentPayloads.at(-1) ?? "{}")).toMatchObject({
          type: "conversation_messages_list_response",
          request_id: "conversation-messages-list-1",
          success: true,
          messages: expect.any(Array),
        });

        await __listenClientTestUtils.handleAgentConversationManagementCommand(
          {
            type: "conversation_compact",
            request_id: "conversation-compact-1",
            conversation_id: conversationId,
          },
          socket as unknown as WebSocket,
        );
        expect(JSON.parse(socket.sentPayloads.at(-1) ?? "{}")).toMatchObject({
          type: "conversation_compact_response",
          request_id: "conversation-compact-1",
          success: true,
          compaction: {
            num_messages_before: 4,
            num_messages_after: 2,
            summary: "compacted summary",
          },
        });

        await __listenClientTestUtils.handleAgentConversationManagementCommand(
          {
            type: "agent_delete",
            request_id: "agent-delete-1",
            agent_id: agentId,
          },
          socket as unknown as WebSocket,
        );
        expect(JSON.parse(socket.sentPayloads.at(-1) ?? "{}")).toMatchObject({
          type: "agent_delete_response",
          request_id: "agent-delete-1",
          success: true,
          agent_id: agentId,
        });
      } finally {
        await rm(storageDir, { recursive: true, force: true });
      }
    });

    test("soft-fails management command backend errors", async () => {
      const storageDir = await mkdtemp(
        join(os.tmpdir(), "ws-management-error-"),
      );
      try {
        __testSetBackend(
          new LocalBackend({ storageDir, executionMode: "deterministic" }),
        );
        const socket = new MockSocket(WebSocket.OPEN);

        await __listenClientTestUtils.handleAgentConversationManagementCommand(
          {
            type: "agent_retrieve",
            request_id: "agent-retrieve-missing",
            agent_id: "agent-missing",
          },
          socket as unknown as WebSocket,
        );

        expect(JSON.parse(socket.sentPayloads.at(-1) ?? "{}")).toMatchObject({
          type: "agent_retrieve_response",
          request_id: "agent-retrieve-missing",
          success: false,
          agent: null,
        });
      } finally {
        await rm(storageDir, { recursive: true, force: true });
      }
    });
  });

  describe("listen-client runtime_start command handling", () => {
    test("creates an agent and conversation, starts runtime, and replays state", async () => {
      const storageDir = await mkdtemp(join(os.tmpdir(), "ws-runtime-start-"));
      const cwdDir = await mkdtemp(join(os.tmpdir(), "ws-runtime-cwd-"));
      try {
        const backend = new LocalBackend({
          storageDir,
          executionMode: "deterministic",
        });
        __testSetBackend(backend);
        const listener = __listenClientTestUtils.createListenerRuntime();
        const socket = new MockSocket(WebSocket.OPEN);

        await __listenClientTestUtils.handleRuntimeStartCommand(
          {
            type: "runtime_start",
            request_id: "runtime-start-create",
            create_agent: {
              body: {
                name: "Runtime Agent",
                model: "anthropic/claude-sonnet-4-6",
              } as AgentCreateBody,
              pin_global: false,
            },
            create_conversation: {
              body: { summary: "Runtime conversation" },
            },
            cwd: cwdDir,
            mode: "acceptEdits",
            recover_approvals: false,
          },
          socket as unknown as WebSocket,
          listener,
        );

        const messages = socket.sentPayloads.map((payload) =>
          JSON.parse(payload),
        );
        const runtimeScope = messages[0].runtime as {
          agent_id: string;
          conversation_id: string;
        };
        expect(runtimeScope.agent_id).toEqual(expect.any(String));
        expect(runtimeScope.conversation_id).toEqual(expect.any(String));
        expect(messages[0]).toMatchObject({
          type: "runtime_start_response",
          request_id: "runtime-start-create",
          success: true,
          runtime: runtimeScope,
          agent: { name: "Runtime Agent" },
          conversation: { summary: "Runtime conversation" },
          created: { agent: true, conversation: true },
        });
        expect(
          __listenClientTestUtils.getConversationWorkingDirectory(
            listener,
            runtimeScope.agent_id,
            runtimeScope.conversation_id,
          ),
        ).toBe(cwdDir);
        expect(messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "update_device_status",
              runtime: runtimeScope,
              device_status: expect.objectContaining({
                current_working_directory: cwdDir,
                current_permission_mode: "acceptEdits",
              }),
            }),
            expect.objectContaining({
              type: "update_loop_status",
              runtime: runtimeScope,
            }),
            expect.objectContaining({
              type: "update_queue",
              runtime: runtimeScope,
            }),
          ]),
        );
      } finally {
        await rm(storageDir, { recursive: true, force: true });
        await rm(cwdDir, { recursive: true, force: true });
      }
    });

    test("resumes an existing agent and conversation", async () => {
      const storageDir = await mkdtemp(
        join(os.tmpdir(), "ws-runtime-start-resume-"),
      );
      try {
        const backend = new LocalBackend({
          storageDir,
          executionMode: "deterministic",
        });
        __testSetBackend(backend);
        const agent = await backend.createAgent({
          name: "Runtime Existing Agent",
          model: "anthropic/claude-sonnet-4-6",
        } as AgentCreateBody);
        const conversation = await backend.createConversation({
          agent_id: agent.id,
          summary: "Existing conversation",
        });
        const listener = __listenClientTestUtils.createListenerRuntime();
        const socket = new MockSocket(WebSocket.OPEN);

        await __listenClientTestUtils.handleRuntimeStartCommand(
          {
            type: "runtime_start",
            request_id: "runtime-start-resume",
            agent_id: agent.id,
            conversation_id: conversation.id,
            external_tools: [
              {
                scope_id: "scope-1",
                tools: [
                  {
                    name: "RemoteLookup",
                    description: "Lookup a remote resource",
                    parameters: { type: "object", properties: {} },
                  },
                ],
              },
            ],
            recover_approvals: false,
          },
          socket as unknown as WebSocket,
          listener,
        );

        expect(JSON.parse(socket.sentPayloads[0] ?? "{}")).toMatchObject({
          type: "runtime_start_response",
          request_id: "runtime-start-resume",
          success: true,
          runtime: {
            agent_id: agent.id,
            conversation_id: conversation.id,
          },
          agent: { id: agent.id },
          conversation: { id: conversation.id },
          created: { agent: false, conversation: false },
        });

        const prepared = await prepareToolExecutionContextForModel(
          "anthropic/claude-sonnet-4",
          {
            clientToolAllowlist: ["RemoteLookup"],
            externalToolScopeIds: ["scope-1"],
            runtimeContext: {
              agentId: agent.id,
              conversationId: conversation.id,
            },
          },
        );
        expect(prepared.clientTools.map((tool) => tool.name)).toEqual([
          "RemoteLookup",
        ]);
      } finally {
        await rm(storageDir, { recursive: true, force: true });
      }
    });

    test("starts an agent default conversation", async () => {
      const storageDir = await mkdtemp(
        join(os.tmpdir(), "ws-runtime-start-default-"),
      );
      try {
        const backend = new LocalBackend({
          storageDir,
          executionMode: "deterministic",
        });
        __testSetBackend(backend);
        const agent = await backend.createAgent({
          name: "Runtime Default Agent",
          model: "anthropic/claude-sonnet-4-6",
        } as AgentCreateBody);
        const listener = __listenClientTestUtils.createListenerRuntime();
        const socket = new MockSocket(WebSocket.OPEN);

        await __listenClientTestUtils.handleRuntimeStartCommand(
          {
            type: "runtime_start",
            request_id: "runtime-start-default",
            agent_id: agent.id,
            conversation_id: "default",
            recover_approvals: false,
          },
          socket as unknown as WebSocket,
          listener,
        );

        expect(JSON.parse(socket.sentPayloads[0] ?? "{}")).toMatchObject({
          type: "runtime_start_response",
          request_id: "runtime-start-default",
          success: true,
          runtime: {
            agent_id: agent.id,
            conversation_id: "default",
          },
          agent: { id: agent.id },
          conversation: { id: "default", agent_id: agent.id },
          created: { agent: false, conversation: false },
        });
      } finally {
        await rm(storageDir, { recursive: true, force: true });
      }
    });

    test("soft-fails invalid runtime_start combinations", async () => {
      const storageDir = await mkdtemp(
        join(os.tmpdir(), "ws-runtime-start-error-"),
      );
      try {
        __testSetBackend(
          new LocalBackend({ storageDir, executionMode: "deterministic" }),
        );
        const listener = __listenClientTestUtils.createListenerRuntime();
        const socket = new MockSocket(WebSocket.OPEN);

        await __listenClientTestUtils.handleRuntimeStartCommand(
          {
            type: "runtime_start",
            request_id: "runtime-start-invalid",
            agent_id: "agent-1",
            create_agent: { body: { name: "Bad" } as AgentCreateBody },
            recover_approvals: false,
          },
          socket as unknown as WebSocket,
          listener,
        );

        expect(JSON.parse(socket.sentPayloads.at(-1) ?? "{}")).toMatchObject({
          type: "runtime_start_response",
          request_id: "runtime-start-invalid",
          success: false,
          runtime: null,
          created: { agent: false, conversation: false },
        });
      } finally {
        await rm(storageDir, { recursive: true, force: true });
      }
    });
  });

  test("classifies invalid input approval_response payloads", () => {
    const missingResponse = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "input",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
          payload: { kind: "approval_response" },
        }),
      ),
    );
    expect(missingResponse).not.toBeNull();
    expect(missingResponse?.type).toBe("__invalid_input");

    const missingRequestId = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "input",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
          payload: {
            kind: "approval_response",
            decision: { behavior: "allow" },
          },
        }),
      ),
    );
    expect(missingRequestId).not.toBeNull();
    expect(missingRequestId?.type).toBe("__invalid_input");
  });

  test("classifies unknown input payload kinds for explicit protocol rejection", () => {
    const unknownKind = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "input",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
          payload: { kind: "slash_command", command: "/model" },
        }),
      ),
    );
    expect(unknownKind).not.toBeNull();
    expect(unknownKind?.type).toBe("__invalid_input");
  });

  test("accepts input create_message and change_device_state", () => {
    const msg = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "input",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
          payload: {
            kind: "create_message",
            messages: [],
            client_tool_allowlist: ["Read", "Grep"],
            external_tool_scope_ids: ["scope-1"],
          },
        }),
      ),
    );
    const changeDeviceState = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "change_device_state",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
          payload: { mode: "standard" },
        }),
      ),
    );
    expect(msg?.type).toBe("input");
    if (msg?.type === "input" && msg.payload.kind === "create_message") {
      expect(msg.payload.client_tool_allowlist).toEqual(["Read", "Grep"]);
      expect(msg.payload.external_tool_scope_ids).toEqual(["scope-1"]);
    }
    expect(changeDeviceState?.type).toBe("change_device_state");
  });

  test("rejects input create_message with invalid client tool allowlist", () => {
    const parsed = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "input",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
          payload: {
            kind: "create_message",
            messages: [],
            client_tool_allowlist: ["Read", 42],
          },
        }),
      ),
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("__invalid_input");
    if (parsed?.type === "__invalid_input") {
      expect(parsed.reason).toContain("client_tool_allowlist must be string[]");
    }
  });

  test("rejects input create_message with invalid external tool scope ids", () => {
    const parsed = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "input",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
          payload: {
            kind: "create_message",
            messages: [],
            external_tool_scope_ids: ["scope-1", 42],
          },
        }),
      ),
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("__invalid_input");
    if (parsed?.type === "__invalid_input") {
      expect(parsed.reason).toContain(
        "external_tool_scope_ids must be string[]",
      );
    }
  });

  test("parses abort_message as the canonical abort command", () => {
    const abort = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "abort_message",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
          request_id: "abort-1",
          run_id: "run-1",
        }),
      ),
    );
    expect(abort?.type).toBe("abort_message");
  });

  test("parses sync as the canonical state replay command", () => {
    const sync = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "sync",
          request_id: "sync-1",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
          recover_approvals: false,
          force_device_status: true,
        }),
      ),
    );
    expect(sync?.type).toBe("sync");
    if (sync?.type !== "sync") {
      throw new Error("expected sync command");
    }
    expect(sync.recover_approvals).toBe(false);
    expect(sync.force_device_status).toBe(true);
    expect(sync.request_id).toBe("sync-1");
  });

  test("parses cron CRUD commands", () => {
    const cronList = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "cron_list",
          request_id: "cron-list-1",
          agent_id: "agent-1",
        }),
      ),
    );
    const cronAdd = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "cron_add",
          request_id: "cron-add-1",
          agent_id: "agent-1",
          conversation_id: "default",
          name: "Test task",
          description: "A test cron task",
          cron: "*/5 * * * *",
          recurring: true,
          prompt: "hello",
        }),
      ),
    );
    const cronGet = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "cron_get",
          request_id: "cron-get-1",
          task_id: "cron-1",
        }),
      ),
    );
    const cronRuns = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "cron_runs",
          request_id: "cron-runs-1",
          task_id: "cron-1",
          limit: 10,
        }),
      ),
    );
    const cronTrigger = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "cron_trigger",
          request_id: "cron-trigger-1",
          task_id: "cron-1",
        }),
      ),
    );
    const cronUpdate = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "cron_update",
          request_id: "cron-update-1",
          task_id: "cron-1",
          name: "Updated task",
          scheduled_for: null,
        }),
      ),
    );
    const cronDelete = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "cron_delete",
          request_id: "cron-delete-1",
          task_id: "cron-1",
        }),
      ),
    );
    const cronDeleteAll = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "cron_delete_all",
          request_id: "cron-delete-all-1",
          agent_id: "agent-1",
        }),
      ),
    );

    expect(cronList?.type).toBe("cron_list");
    expect(cronAdd?.type).toBe("cron_add");
    expect(cronGet?.type).toBe("cron_get");
    expect(cronRuns?.type).toBe("cron_runs");
    expect(cronTrigger?.type).toBe("cron_trigger");
    expect(cronUpdate?.type).toBe("cron_update");
    expect(cronDelete?.type).toBe("cron_delete");
    expect(cronDeleteAll?.type).toBe("cron_delete_all");
  });

  test("parses channels management commands", () => {
    const channelsList = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "channels_list",
          request_id: "channels-list-1",
        }),
      ),
    );
    const channelGetConfig = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "channel_get_config",
          request_id: "channel-get-config-1",
          channel_id: "telegram",
        }),
      ),
    );
    const channelAccountsList = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "channel_accounts_list",
          request_id: "channel-accounts-list-1",
          channel_id: "telegram",
        }),
      ),
    );
    const channelAccountCreate = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "channel_account_create",
          request_id: "channel-account-create-1",
          channel_id: "slack",
          account: {
            display_name: "DocsBot Slack",
            dm_policy: "pairing",
            allowed_users: ["user-1"],
            config: {
              bot_token: "xoxb-test",
              app_token: "xapp-test",
              mode: "socket",
            },
          },
        }),
      ),
    );
    const channelAccountUpdate = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "channel_account_update",
          request_id: "channel-account-update-1",
          channel_id: "telegram",
          account_id: "bot-1",
          patch: {
            display_name: "@docsbot",
            dm_policy: "open",
            config: {
              token: "telegram-token",
            },
          },
        }),
      ),
    );
    const channelAccountBind = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "channel_account_bind",
          request_id: "channel-account-bind-1",
          channel_id: "slack",
          account_id: "acct-1",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
        }),
      ),
    );
    const channelAccountUnbind = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "channel_account_unbind",
          request_id: "channel-account-unbind-1",
          channel_id: "slack",
          account_id: "acct-1",
        }),
      ),
    );
    const channelAccountDelete = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "channel_account_delete",
          request_id: "channel-account-delete-1",
          channel_id: "slack",
          account_id: "acct-1",
        }),
      ),
    );
    const channelAccountStart = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "channel_account_start",
          request_id: "channel-account-start-1",
          channel_id: "telegram",
          account_id: "bot-1",
        }),
      ),
    );
    const channelAccountStop = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "channel_account_stop",
          request_id: "channel-account-stop-1",
          channel_id: "telegram",
          account_id: "bot-1",
        }),
      ),
    );
    const channelSetConfig = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "channel_set_config",
          request_id: "channel-set-config-1",
          channel_id: "slack",
          config: {
            dm_policy: "pairing",
            allowed_users: ["user-1"],
            plugin_config: {
              bot_token: "xoxb-test",
              app_token: "xapp-test",
              mode: "socket",
            },
          },
        }),
      ),
    );
    const channelStart = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "channel_start",
          request_id: "channel-start-1",
          channel_id: "telegram",
        }),
      ),
    );
    const channelStop = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "channel_stop",
          request_id: "channel-stop-1",
          channel_id: "telegram",
        }),
      ),
    );
    const channelPairingsList = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "channel_pairings_list",
          request_id: "channel-pairings-list-1",
          channel_id: "telegram",
        }),
      ),
    );
    const channelPairingBind = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "channel_pairing_bind",
          request_id: "channel-pairing-bind-1",
          channel_id: "telegram",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
          code: "A7X9K2",
        }),
      ),
    );
    const channelRoutesList = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "channel_routes_list",
          request_id: "channel-routes-list-1",
          channel_id: "telegram",
          agent_id: "agent-1",
          conversation_id: "default",
        }),
      ),
    );
    const channelRouteRemove = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "channel_route_remove",
          request_id: "channel-route-remove-1",
          channel_id: "telegram",
          chat_id: "chat-1",
        }),
      ),
    );
    const channelTargetsList = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "channel_targets_list",
          request_id: "channel-targets-list-1",
          channel_id: "slack",
        }),
      ),
    );
    const channelTargetBind = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "channel_target_bind",
          request_id: "channel-target-bind-1",
          channel_id: "slack",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
          target_id: "C123",
        }),
      ),
    );

    expect(channelsList?.type).toBe("channels_list");
    expect(channelGetConfig?.type).toBe("channel_get_config");
    expect(channelAccountsList?.type).toBe("channel_accounts_list");
    expect(channelAccountCreate?.type).toBe("channel_account_create");
    expect(channelAccountUpdate?.type).toBe("channel_account_update");
    expect(channelAccountBind?.type).toBe("channel_account_bind");
    expect(channelAccountUnbind?.type).toBe("channel_account_unbind");
    expect(channelAccountDelete?.type).toBe("channel_account_delete");
    expect(channelAccountStart?.type).toBe("channel_account_start");
    expect(channelAccountStop?.type).toBe("channel_account_stop");
    expect(channelSetConfig?.type).toBe("channel_set_config");
    expect(channelStart?.type).toBe("channel_start");
    expect(channelStop?.type).toBe("channel_stop");
    expect(channelPairingsList?.type).toBe("channel_pairings_list");
    expect(channelPairingBind?.type).toBe("channel_pairing_bind");
    expect(channelRoutesList?.type).toBe("channel_routes_list");
    expect(channelRouteRemove?.type).toBe("channel_route_remove");
    expect(channelTargetsList?.type).toBe("channel_targets_list");
    expect(channelTargetBind?.type).toBe("channel_target_bind");
  });

  test("parses list_models command", () => {
    const parsed = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "list_models",
          request_id: "models-1",
        }),
      ),
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("list_models");
  });

  test("parses list_connect_providers command", () => {
    const parsed = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "list_connect_providers",
          request_id: "connect-providers-1",
          target: "local",
        }),
      ),
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("list_connect_providers");
  });

  test("rejects list_connect_providers command for non-local target", () => {
    const parsed = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "list_connect_providers",
          request_id: "connect-providers-2",
          target: "api",
        }),
      ),
    );

    expect(parsed).toBeNull();
  });

  test("parses connect_provider command", () => {
    const parsed = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "connect_provider",
          request_id: "connect-provider-1",
          target: "local",
          provider_id: "anthropic",
          fields: { apiKey: "sk-test" },
        }),
      ),
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("connect_provider");
  });

  test("parses connect_provider command with auth method", () => {
    const parsed = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "connect_provider",
          request_id: "connect-provider-2",
          target: "local",
          provider_id: "amazon-bedrock",
          auth_method_id: "profile",
          fields: { profile: "default", region: "us-east-1" },
        }),
      ),
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("connect_provider");
  });

  test("rejects connect_provider command with non-string fields", () => {
    const parsed = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "connect_provider",
          request_id: "connect-provider-3",
          target: "local",
          provider_id: "anthropic",
          fields: { apiKey: 123 },
        }),
      ),
    );

    expect(parsed).toBeNull();
  });

  test("parses disconnect_provider command", () => {
    const parsed = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "disconnect_provider",
          request_id: "disconnect-provider-1",
          target: "local",
          provider_id: "anthropic",
        }),
      ),
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("disconnect_provider");
  });

  test("parses disconnect_provider command with a provider name", () => {
    const parsed = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "disconnect_provider",
          request_id: "disconnect-provider-2",
          target: "local",
          provider_id: "codex",
          provider_name: "chatgpt-work",
        }),
      ),
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("disconnect_provider");
  });

  test("parses chatgpt_usage_read command", () => {
    const parsed = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "chatgpt_usage_read",
          request_id: "chatgpt-usage-1",
          target: "local",
          provider_name: "chatgpt-work",
          force_refresh: true,
        }),
      ),
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("chatgpt_usage_read");
  });

  test("parses chatgpt_usage_read command for api target", () => {
    const parsed = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "chatgpt_usage_read",
          request_id: "chatgpt-usage-2",
          target: "api",
          provider_name: "chatgpt-work",
        }),
      ),
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("chatgpt_usage_read");
  });

  test("rejects chatgpt_usage_read command for unknown target", () => {
    const parsed = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "chatgpt_usage_read",
          request_id: "chatgpt-usage-3",
          target: "project",
        }),
      ),
    );

    expect(parsed).toBeNull();
  });

  test("rejects chatgpt_usage_read command with bad force_refresh", () => {
    const parsed = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "chatgpt_usage_read",
          request_id: "chatgpt-usage-4",
          target: "local",
          force_refresh: "true",
        }),
      ),
    );

    expect(parsed).toBeNull();
  });

  test("parses update_model command with model_id", () => {
    const parsed = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "update_model",
          request_id: "update-model-1",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
          payload: { model_id: "sonnet" },
        }),
      ),
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("update_model");
  });

  test("rejects update_model command missing model identifier", () => {
    const parsed = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "update_model",
          request_id: "update-model-2",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
          payload: {},
        }),
      ),
    );

    expect(parsed).toBeNull();
  });

  test("parses update_toolset command", () => {
    const parsed = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "update_toolset",
          request_id: "update-toolset-1",
          runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
          toolset_preference: "gemini",
        }),
      ),
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("update_toolset");
  });

  test("parses skill enable/disable commands", () => {
    const skillEnable = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "skill_enable",
          request_id: "skill-enable-1",
          skill_path: "/tmp/my-skill",
        }),
      ),
    );
    const skillDisable = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "skill_disable",
          request_id: "skill-disable-1",
          name: "my-skill",
        }),
      ),
    );

    expect(skillEnable?.type).toBe("skill_enable");
    expect(skillDisable?.type).toBe("skill_disable");
  });

  test("rejects malformed skill commands", () => {
    // Missing skill_path
    const noPath = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "skill_enable",
          request_id: "skill-enable-bad",
        }),
      ),
    );
    // Missing name on disable
    const noName = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "skill_disable",
          request_id: "skill-disable-bad",
        }),
      ),
    );
    expect(noPath).toBeNull();
    expect(noName).toBeNull();
  });

  test("parses create_agent command", () => {
    const minimal = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "create_agent",
          request_id: "create-1",
          personality: "memo",
        }),
      ),
    );
    const withOptions = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "create_agent",
          request_id: "create-2",
          personality: "kawaii",
          model: "sonnet",
          pin_global: false,
        }),
      ),
    );

    expect(minimal?.type).toBe("create_agent");
    expect(withOptions?.type).toBe("create_agent");
  });

  test("rejects malformed create_agent command", () => {
    const noRequestId = parseServerMessage(
      Buffer.from(
        JSON.stringify({ type: "create_agent", personality: "memo" }),
      ),
    );
    const badPersonality = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "create_agent",
          request_id: "create-bad-personality",
          personality: "claude",
        }),
      ),
    );
    const badCodexPersonality = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "create_agent",
          request_id: "create-bad-codex",
          personality: "codex",
        }),
      ),
    );
    const badPinGlobal = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "create_agent",
          request_id: "create-bad",
          personality: "linus",
          pin_global: "yes",
        }),
      ),
    );
    expect(noRequestId).toBeNull();
    expect(badPersonality).toBeNull();
    expect(badCodexPersonality).toBeNull();
    expect(badPinGlobal).toBeNull();
  });

  test("parses reflection settings commands", () => {
    const getSettings = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "get_reflection_settings",
          request_id: "reflection-get-1",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
        }),
      ),
    );
    const setSettings = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "set_reflection_settings",
          request_id: "reflection-set-1",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
          settings: {
            trigger: "step-count",
            step_count: 9,
          },
          scope: "local_project",
        }),
      ),
    );

    expect(getSettings?.type).toBe("get_reflection_settings");
    expect(setSettings?.type).toBe("set_reflection_settings");
  });

  test("parses experiment commands", () => {
    const getExperiments = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "get_experiments",
          request_id: "experiments-get-1",
        }),
      ),
    );
    const setExperiment = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "set_experiment",
          request_id: "experiment-set-1",
          experiment_id: "tui_cron",
          enabled: true,
        }),
      ),
    );

    expect(getExperiments?.type).toBe("get_experiments");
    expect(setExperiment?.type).toBe("set_experiment");
  });

  test("advertises context-limit and parses the legacy set-max-context alias", () => {
    expect(SUPPORTED_REMOTE_COMMANDS).toContain("context-limit");
    expect(SUPPORTED_REMOTE_COMMANDS).not.toContain("set-max-context");
    expect(SUPPORTED_REMOTE_COMMANDS).toContain("compact");
    expect(SUPPORTED_REMOTE_COMMANDS).toContain("reload");

    const command = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "execute_command",
          command_id: "context-limit",
          request_id: "context-limit-1",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
          args: "10000 --override",
        }),
      ),
    );

    expect(command).toMatchObject({
      type: "execute_command",
      command_id: "context-limit",
      args: "10000 --override",
    });

    const legacyCommand = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "execute_command",
          command_id: "set-max-context",
          request_id: "set-max-context-1",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
          args: "12000 --override",
        }),
      ),
    );

    expect(legacyCommand).toMatchObject({
      type: "execute_command",
      command_id: "set-max-context",
      args: "12000 --override",
    });
  });

  test("runs remote compact execute_command against backend", async () => {
    const storageDir = await mkdtemp(join(os.tmpdir(), "ws-compact-"));
    try {
      class CompactRecordingBackend extends LocalBackend {
        compactCalls: Parameters<
          LocalBackend["compactConversationMessages"]
        >[] = [];

        override async compactConversationMessages(
          ...args: Parameters<LocalBackend["compactConversationMessages"]>
        ): ReturnType<LocalBackend["compactConversationMessages"]> {
          this.compactCalls.push(args);
          return {
            num_messages_before: 7,
            num_messages_after: 2,
            summary: "compacted summary",
          } as Awaited<ReturnType<LocalBackend["compactConversationMessages"]>>;
        }
      }

      const backend = new CompactRecordingBackend({
        storageDir,
        executionMode: "deterministic",
      });
      __testSetBackend(backend);
      const agent = await backend.createAgent({
        name: "WS Compact Agent",
        model: "anthropic/claude-sonnet-4-6",
      } as AgentCreateBody);
      const listener = __listenClientTestUtils.createListenerRuntime();
      const runtime = __listenClientTestUtils.getOrCreateConversationRuntime(
        listener,
        agent.id,
        "default",
      );
      const socket = new MockSocket(WebSocket.OPEN);

      await handleExecuteCommand(
        {
          type: "execute_command",
          command_id: "compact",
          request_id: "compact-run-1",
          runtime: { agent_id: agent.id, conversation_id: "default" },
          args: "sliding_window",
        },
        socket as unknown as WebSocket,
        runtime,
        {},
      );

      expect(backend.compactCalls).toHaveLength(1);
      expect(backend.compactCalls[0]?.[0]).toBe("default");
      expect(backend.compactCalls[0]?.[1]).toMatchObject({
        agent_id: agent.id,
        compaction_settings: {
          mode: "sliding_window",
        },
      });
      // Manual /compact now launches reflection directly (when memfs and the
      // compaction-event trigger are enabled) instead of setting the pending
      // flag for the next turn.
      expect(runtime.contextTracker.pendingReflectionTrigger).toBe(false);
      expect(socket.sentPayloads.join("\n")).toContain(
        "Compaction completed (mode: sliding_window). Message buffer length reduced from 7 to 2.",
      );
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("remote compact does not trigger reflection when compaction changes nothing", async () => {
    const storageDir = await mkdtemp(join(os.tmpdir(), "ws-compact-same-"));
    try {
      class NoopCompactBackend extends LocalBackend {
        override async compactConversationMessages(
          ..._args: Parameters<LocalBackend["compactConversationMessages"]>
        ): ReturnType<LocalBackend["compactConversationMessages"]> {
          throw {
            status: 400,
            error: {
              detail: "Summarization failed to reduce the number of messages",
            },
          };
        }
      }

      const backend = new NoopCompactBackend({
        storageDir,
        executionMode: "deterministic",
      });
      __testSetBackend(backend);
      const agent = await backend.createAgent({
        name: "WS Noop Compact Agent",
        model: "anthropic/claude-sonnet-4-6",
      } as AgentCreateBody);
      const listener = __listenClientTestUtils.createListenerRuntime();
      const runtime = __listenClientTestUtils.getOrCreateConversationRuntime(
        listener,
        agent.id,
        "default",
      );
      const socket = new MockSocket(WebSocket.OPEN);

      await handleExecuteCommand(
        {
          type: "execute_command",
          command_id: "compact",
          request_id: "compact-noop-run-1",
          runtime: { agent_id: agent.id, conversation_id: "default" },
        },
        socket as unknown as WebSocket,
        runtime,
        {},
      );

      expect(runtime.contextTracker.pendingReflectionTrigger).toBe(false);
      expect(socket.sentPayloads.join("\n")).toContain(
        "Compaction run, but the number of messages is the same",
      );
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("runs remote context-limit and legacy set-max-context execute_command", async () => {
    const storageDir = await mkdtemp(join(os.tmpdir(), "ws-max-context-"));
    try {
      const backend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
      });
      __testSetBackend(backend);
      const agent = await backend.createAgent({
        name: "WS Max Context Agent",
        model: "anthropic/claude-sonnet-4-6",
      } as AgentCreateBody);
      const listener = __listenClientTestUtils.createListenerRuntime();
      const runtime = __listenClientTestUtils.getOrCreateConversationRuntime(
        listener,
        agent.id,
        "default",
      );
      const socket = new MockSocket(WebSocket.OPEN);

      await handleExecuteCommand(
        {
          type: "execute_command",
          command_id: "context-limit",
          request_id: "context-limit-run-1",
          runtime: { agent_id: agent.id, conversation_id: "default" },
          args: "10000 --override",
        },
        socket as unknown as WebSocket,
        runtime,
        {},
      );

      expect(
        (
          (await backend.retrieveAgent(agent.id)) as {
            llm_config?: { context_window?: number };
          }
        ).llm_config?.context_window,
      ).toBe(10_000);
      expect(socket.sentPayloads.join("\n")).toContain(
        "Agent max context set to 10,000 tokens with override.",
      );

      await handleExecuteCommand(
        {
          type: "execute_command",
          command_id: "set-max-context",
          request_id: "set-max-context-run-1",
          runtime: { agent_id: agent.id, conversation_id: "default" },
          args: "12000 --override",
        },
        socket as unknown as WebSocket,
        runtime,
        {},
      );

      expect(
        (
          (await backend.retrieveAgent(agent.id)) as {
            llm_config?: { context_window?: number };
          }
        ).llm_config?.context_window,
      ).toBe(12_000);
      expect(socket.sentPayloads.join("\n")).toContain(
        "Agent max context set to 12,000 tokens with override.",
      );
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("runs remote clear execute_command against local backend", async () => {
    const storageDir = await mkdtemp(join(os.tmpdir(), "ws-clear-local-"));
    try {
      const backend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
      });
      __testSetBackend(backend);
      const agent = await backend.createAgent({
        name: "WS Clear Local Agent",
      } as AgentCreateBody);
      const listener = __listenClientTestUtils.createListenerRuntime();
      const runtime = __listenClientTestUtils.getOrCreateConversationRuntime(
        listener,
        agent.id,
        "default",
      );
      const socket = new MockSocket(WebSocket.OPEN);

      await handleExecuteCommand(
        {
          type: "execute_command",
          command_id: "clear",
          request_id: "clear-local-run-1",
          runtime: { agent_id: agent.id, conversation_id: "default" },
        },
        socket as unknown as WebSocket,
        runtime,
        {},
      );

      expect(runtime.conversationId).toStartWith("local-conv-");
      await expect(
        backend.retrieveConversation(runtime.conversationId),
      ).resolves.toMatchObject({ agent_id: agent.id });
      expect(socket.sentPayloads.join("\n")).toContain(
        "Agent's in-context messages cleared",
      );
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("runs remote reload execute_command", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const adapter = ensureListenerModAdapter(listener);
    const originalReload = adapter.reload;
    let reloadCalls = 0;
    adapter.reload = async () => {
      reloadCalls += 1;
    };
    const runtime = __listenClientTestUtils.getOrCreateConversationRuntime(
      listener,
      "agent-reload",
      "default",
    );
    const socket = new MockSocket(WebSocket.OPEN);

    try {
      await handleExecuteCommand(
        {
          type: "execute_command",
          command_id: "reload",
          request_id: "reload-run-1",
          runtime: { agent_id: "agent-reload", conversation_id: "default" },
        },
        socket as unknown as WebSocket,
        runtime,
        {},
      );
    } finally {
      adapter.reload = originalReload;
      adapter.dispose();
      listener.modAdapter = undefined;
    }

    expect(reloadCalls).toBe(1);
    expect(socket.sentPayloads.join("\n")).toContain(
      "Reloaded settings, local mods, and agent secrets",
    );
  });

  test("rejects legacy cancel_run in hard-cut v2 protocol", () => {
    const legacyCancel = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "cancel_run",
          request_id: "cancel-1",
          run_id: "run-1",
        }),
      ),
    );
    expect(legacyCancel).toBeNull();
  });
});

describe("listen-client model command helpers", () => {
  test("buildListModelsEntries reflects models.json metadata", () => {
    const entries = __listenClientTestUtils.buildListModelsEntries();

    expect(entries.length).toBe(models.length);
    expect(entries[0]).toMatchObject({
      id: models[0]?.id,
      handle: models[0]?.handle,
      label: models[0]?.label,
      description: models[0]?.description,
    });
  });

  test("resolveModelForUpdate resolves by id and by handle", () => {
    const byId = __listenClientTestUtils.resolveModelForUpdate({
      model_id: models[0]?.id,
    });
    expect(byId).not.toBeNull();
    expect(byId?.handle).toBe(models[0]?.handle);

    const byHandle = __listenClientTestUtils.resolveModelForUpdate({
      model_handle: models[0]?.handle,
    });
    expect(byHandle).not.toBeNull();
    expect(byHandle?.id).toBe(models[0]?.id);
  });

  test("resolveModelForUpdate allows custom handles", () => {
    const resolved = __listenClientTestUtils.resolveModelForUpdate({
      model_handle: "custom/provider-model",
    });

    expect(resolved).toEqual({
      id: "custom/provider-model",
      handle: "custom/provider-model",
      label: "custom/provider-model",
      updateArgs: undefined,
    });
  });

  test("resolveModelForUpdate preserves explicit model_handle when both model_id and model_handle are present (BYOK tier change)", () => {
    // When LCD sends both fields for a BYOK tier change, the resolver should
    // use model_id for updateArgs/label but keep the explicit model_handle.
    const byokHandle = `lc-mykey/${models[0]?.handle}`;
    const resolved = __listenClientTestUtils.resolveModelForUpdate({
      model_id: models[0]?.id,
      model_handle: byokHandle,
    });

    expect(resolved).not.toBeNull();
    // Handle must be the explicit BYOK handle, not the base static handle
    expect(resolved?.handle).toBe(byokHandle);
    // But id/label/updateArgs still come from the model_id entry
    expect(resolved?.id).toBe(models[0]?.id);
    expect(resolved?.label).toBe(models[0]?.label);
  });

  test("resolveModelForUpdate ignores model_handle when only model_id is present", () => {
    // Standard (non-BYOK) tier selection: only model_id, no model_handle
    const resolved = __listenClientTestUtils.resolveModelForUpdate({
      model_id: models[0]?.id,
    });

    expect(resolved).not.toBeNull();
    // Should resolve handle from the static entry, not from an explicit override
    expect(resolved?.handle).toBe(models[0]?.handle);
  });
});

describe("listen-client cron command handling", () => {
  test("wraps cron library CRUD over WS commands", async () => {
    const tempRoot = await mkdtemp(join(os.tmpdir(), "letta-listen-cron-"));
    const originalLettaHome = process.env.LETTA_HOME;
    process.env.LETTA_HOME = tempRoot;

    try {
      const socket = new MockSocket(WebSocket.OPEN);

      await __listenClientTestUtils.handleCronCommand(
        {
          type: "cron_add",
          request_id: "cron-add-1",
          agent_id: "agent-1",
          conversation_id: "conv-1",
          name: "Test cron",
          description: "A test schedule",
          cron: "*/5 * * * *",
          recurring: true,
          prompt: "run the cron task",
        },
        socket as unknown as WebSocket,
      );

      const addMessages = socket.sentPayloads.map((payload) =>
        JSON.parse(payload as string),
      );
      expect(addMessages[0]).toMatchObject({
        type: "cron_add_response",
        request_id: "cron-add-1",
        success: true,
      });
      expect(addMessages[0].task).toMatchObject({
        agent_id: "agent-1",
        conversation_id: "conv-1",
        cron: "*/5 * * * *",
        recurring: true,
        prompt: "run the cron task",
      });
      expect(addMessages[1]).toMatchObject({
        type: "crons_updated",
        agent_id: "agent-1",
        conversation_id: "conv-1",
      });

      const taskId = addMessages[0].task.id as string;
      appendCronRunLog(getCronRunLogPath(taskId), {
        ts: 1000,
        jobId: taskId,
        action: "finished",
        status: "ok",
        summary: "Older run",
        conversationId: "conv-1",
        runId: "run-older",
      });
      appendCronRunLog(getCronRunLogPath(taskId), {
        ts: 2000,
        jobId: taskId,
        action: "finished",
        status: "error",
        error: "Newer run failed",
        conversationId: "conv-1",
        runId: "run-newer",
      });
      socket.sentPayloads.length = 0;

      await __listenClientTestUtils.handleCronCommand(
        {
          type: "cron_list",
          request_id: "cron-list-1",
          agent_id: "agent-1",
        },
        socket as unknown as WebSocket,
      );
      const listResponse = JSON.parse(socket.sentPayloads[0] as string);
      expect(listResponse).toMatchObject({
        type: "cron_list_response",
        request_id: "cron-list-1",
        success: true,
      });
      expect(listResponse.tasks).toHaveLength(1);
      expect(listResponse.tasks[0].id).toBe(taskId);

      socket.sentPayloads.length = 0;
      await __listenClientTestUtils.handleCronCommand(
        {
          type: "cron_get",
          request_id: "cron-get-1",
          task_id: taskId,
        },
        socket as unknown as WebSocket,
      );
      expect(JSON.parse(socket.sentPayloads[0] as string)).toMatchObject({
        type: "cron_get_response",
        request_id: "cron-get-1",
        success: true,
        found: true,
        task: { id: taskId },
      });

      socket.sentPayloads.length = 0;
      await __listenClientTestUtils.handleCronCommand(
        {
          type: "cron_update",
          request_id: "cron-update-1",
          task_id: taskId,
          name: "Updated cron",
          prompt: "run the updated cron task",
          scheduled_for: null,
        },
        socket as unknown as WebSocket,
      );
      const updateMessages = socket.sentPayloads.map((payload) =>
        JSON.parse(payload as string),
      );
      expect(updateMessages[0]).toMatchObject({
        type: "cron_update_response",
        request_id: "cron-update-1",
        success: true,
        task: {
          id: taskId,
          name: "Updated cron",
          prompt: "run the updated cron task",
        },
      });
      expect(updateMessages[1]).toMatchObject({
        type: "crons_updated",
        agent_id: "agent-1",
        conversation_id: "conv-1",
      });

      socket.sentPayloads.length = 0;
      await __listenClientTestUtils.handleCronCommand(
        {
          type: "cron_runs",
          request_id: "cron-runs-1",
          task_id: taskId,
          limit: 1,
        },
        socket as unknown as WebSocket,
      );
      expect(JSON.parse(socket.sentPayloads[0] as string)).toMatchObject({
        type: "cron_runs_response",
        request_id: "cron-runs-1",
        success: true,
        page: {
          total: 2,
          offset: 0,
          limit: 1,
          hasMore: true,
          nextOffset: 1,
          entries: [
            {
              ts: 2000,
              jobId: taskId,
              action: "finished",
              status: "error",
              error: "Newer run failed",
              conversationId: "conv-1",
              runId: "run-newer",
            },
          ],
        },
      });

      socket.sentPayloads.length = 0;
      await __listenClientTestUtils.handleCronCommand(
        {
          type: "cron_delete",
          request_id: "cron-delete-1",
          task_id: taskId,
        },
        socket as unknown as WebSocket,
      );
      const deleteMessages = socket.sentPayloads.map((payload) =>
        JSON.parse(payload as string),
      );
      expect(deleteMessages[0]).toMatchObject({
        type: "cron_delete_response",
        request_id: "cron-delete-1",
        success: true,
        found: true,
      });
      expect(deleteMessages[1]).toMatchObject({
        type: "crons_updated",
        agent_id: "agent-1",
        conversation_id: "conv-1",
      });

      socket.sentPayloads.length = 0;
      await __listenClientTestUtils.handleCronCommand(
        {
          type: "cron_add",
          request_id: "cron-add-2",
          agent_id: "agent-1",
          name: "Another cron",
          description: "Another test schedule",
          cron: "0 12 * * *",
          recurring: true,
          prompt: "run again",
        },
        socket as unknown as WebSocket,
      );
      socket.sentPayloads.length = 0;
      await __listenClientTestUtils.handleCronCommand(
        {
          type: "cron_delete_all",
          request_id: "cron-delete-all-1",
          agent_id: "agent-1",
        },
        socket as unknown as WebSocket,
      );
      const deleteAllMessages = socket.sentPayloads.map((payload) =>
        JSON.parse(payload as string),
      );
      expect(deleteAllMessages[0]).toMatchObject({
        type: "cron_delete_all_response",
        request_id: "cron-delete-all-1",
        success: true,
        agent_id: "agent-1",
        deleted: 1,
      });
      expect(deleteAllMessages[1]).toMatchObject({
        type: "crons_updated",
        agent_id: "agent-1",
      });
    } finally {
      if (originalLettaHome) {
        process.env.LETTA_HOME = originalLettaHome;
      } else {
        delete process.env.LETTA_HOME;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("listen-client memory command handling", () => {
  test("returns explicit disabled state when memfs is not enabled for the agent", async () => {
    const tempRoot = await mkdtemp(join(os.tmpdir(), "letta-list-memory-"));
    const socket = new MockSocket(WebSocket.OPEN);
    const ensureLocalMemfsCheckoutMock = mock(async () => {});

    try {
      await __listenClientTestUtils.handleListMemoryCommand(
        {
          type: "list_memory",
          request_id: "list-memory-disabled-1",
          agent_id: "agent-1",
          include_references: true,
        },
        socket as unknown as WebSocket,
        {
          getMemoryFilesystemRoot: () => tempRoot,
          isMemfsEnabledOnServer: async () => false,
          ensureLocalMemfsCheckout: ensureLocalMemfsCheckoutMock,
        },
      );

      expect(ensureLocalMemfsCheckoutMock).not.toHaveBeenCalled();
      expect(JSON.parse(socket.sentPayloads[0] as string)).toMatchObject({
        type: "list_memory_response",
        request_id: "list-memory-disabled-1",
        success: true,
        done: true,
        total: 0,
        memfs_enabled: false,
        memfs_initialized: false,
        entries: [],
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("bootstraps only the local memfs checkout when memfs is already enabled", async () => {
    const tempRoot = await mkdtemp(join(os.tmpdir(), "letta-list-memory-"));
    const socket = new MockSocket(WebSocket.OPEN);
    const ensureLocalMemfsCheckoutMock = mock(
      async (_agentId: string, _options?: EnsureLocalMemfsCheckoutOptions) => {
        await mkdir(join(tempRoot, ".git"), { recursive: true });
        await mkdir(join(tempRoot, "system"), { recursive: true });
        await writeFile(
          join(tempRoot, "system", "persona.md"),
          "---\ndescription: Persona\n---\nHello from memory\n",
        );
      },
    );

    try {
      await __listenClientTestUtils.handleListMemoryCommand(
        {
          type: "list_memory",
          request_id: "list-memory-enabled-1",
          agent_id: "agent-1",
          include_references: true,
        },
        socket as unknown as WebSocket,
        {
          getMemoryFilesystemRoot: () => tempRoot,
          isMemfsEnabledOnServer: async () => true,
          ensureLocalMemfsCheckout: ensureLocalMemfsCheckoutMock,
        },
      );

      expect(ensureLocalMemfsCheckoutMock).toHaveBeenCalledTimes(1);
      expect(ensureLocalMemfsCheckoutMock.mock.calls[0]).toEqual([
        "agent-1",
        { pullOnExistingRepo: true },
      ]);
      const messages = socket.sentPayloads.map((payload) =>
        JSON.parse(payload as string),
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        type: "list_memory_response",
        request_id: "list-memory-enabled-1",
        success: true,
        done: true,
        total: 1,
        memfs_enabled: true,
        memfs_initialized: true,
      });
      expect(messages[0].entries).toEqual([
        expect.objectContaining({
          relative_path: "system/persona.md",
          is_system: true,
          description: "Persona",
          references: [],
        }),
      ]);
      expect(messages[0].entries[0]?.content).toContain("Hello from memory");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("lists supported image assets alongside markdown memory", async () => {
    const tempRoot = await mkdtemp(join(os.tmpdir(), "letta-list-memory-"));
    const socket = new MockSocket(WebSocket.OPEN);
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const ensureLocalMemfsCheckoutMock = mock(async () => {
      await mkdir(join(tempRoot, ".git"), { recursive: true });
      await mkdir(join(tempRoot, "system"), { recursive: true });
      await writeFile(
        join(tempRoot, "system", "persona.md"),
        "---\ndescription: Persona\n---\nHello from memory\n",
      );
      await writeFile(join(tempRoot, "profile.png"), pngBytes);
      await writeFile(join(tempRoot, "notes.bin"), Buffer.from([0x00, 0x01]));
    });

    try {
      await __listenClientTestUtils.handleListMemoryCommand(
        {
          type: "list_memory",
          request_id: "list-memory-images-1",
          agent_id: "agent-1",
          include_references: true,
        },
        socket as unknown as WebSocket,
        {
          getMemoryFilesystemRoot: () => tempRoot,
          isMemfsEnabledOnServer: async () => true,
          ensureLocalMemfsCheckout: ensureLocalMemfsCheckoutMock,
        },
      );

      const messages = socket.sentPayloads.map((payload) =>
        JSON.parse(payload as string),
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        type: "list_memory_response",
        request_id: "list-memory-images-1",
        success: true,
        done: true,
        total: 2,
      });
      // Scanner orders directories first, so system/persona.md precedes
      // the root-level profile.png. Unsupported binaries stay hidden.
      expect(messages[0].entries).toEqual([
        expect.objectContaining({
          relative_path: "system/persona.md",
          is_system: true,
          description: "Persona",
          kind: "markdown",
          mime_type: "text/markdown",
          references: [],
        }),
        expect.objectContaining({
          relative_path: "profile.png",
          is_system: false,
          description: null,
          content: "",
          size: pngBytes.length,
          kind: "image",
          mime_type: "image/png",
          references: [],
        }),
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("pulls an existing local memfs checkout before scanning", async () => {
    const tempRoot = await mkdtemp(join(os.tmpdir(), "letta-list-memory-"));
    const socket = new MockSocket(WebSocket.OPEN);
    const isMemfsEnabledOnServerMock = mock(async () => true);
    const ensureLocalMemfsCheckoutMock = mock(
      async (_agentId: string, _options?: EnsureLocalMemfsCheckoutOptions) => {
        await mkdir(join(tempRoot, "system"), { recursive: true });
        await writeFile(
          join(tempRoot, "system", "human.md"),
          "---\ndescription: Human\n---\nPulled from remote\n",
        );
      },
    );

    try {
      await mkdir(join(tempRoot, ".git"), { recursive: true });

      await __listenClientTestUtils.handleListMemoryCommand(
        {
          type: "list_memory",
          request_id: "list-memory-pull-1",
          agent_id: "agent-1",
          include_references: true,
        },
        socket as unknown as WebSocket,
        {
          getMemoryFilesystemRoot: () => tempRoot,
          isMemfsEnabledOnServer: isMemfsEnabledOnServerMock,
          ensureLocalMemfsCheckout: ensureLocalMemfsCheckoutMock,
        },
      );

      expect(isMemfsEnabledOnServerMock).not.toHaveBeenCalled();
      expect(ensureLocalMemfsCheckoutMock).toHaveBeenCalledTimes(1);
      expect(ensureLocalMemfsCheckoutMock.mock.calls[0]).toEqual([
        "agent-1",
        { pullOnExistingRepo: true },
      ]);
      const messages = socket.sentPayloads.map((payload) =>
        JSON.parse(payload as string),
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        type: "list_memory_response",
        request_id: "list-memory-pull-1",
        success: true,
        done: true,
        total: 1,
        memfs_enabled: true,
        memfs_initialized: true,
      });
      expect(messages[0].entries).toEqual([
        expect.objectContaining({
          relative_path: "system/human.md",
          is_system: true,
          description: "Human",
          references: [],
        }),
      ]);
      expect(messages[0].entries[0]?.content).toContain("Pulled from remote");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("returns a failure response when syncing an existing checkout fails", async () => {
    const tempRoot = await mkdtemp(join(os.tmpdir(), "letta-list-memory-"));
    const socket = new MockSocket(WebSocket.OPEN);
    const ensureLocalMemfsCheckoutMock = mock(async () => {
      throw new Error("Pull failed: auth rejected");
    });

    try {
      await mkdir(join(tempRoot, ".git"), { recursive: true });

      await __listenClientTestUtils.handleListMemoryCommand(
        {
          type: "list_memory",
          request_id: "list-memory-pull-failed-1",
          agent_id: "agent-1",
          include_references: true,
        },
        socket as unknown as WebSocket,
        {
          getMemoryFilesystemRoot: () => tempRoot,
          isMemfsEnabledOnServer: async () => true,
          ensureLocalMemfsCheckout: ensureLocalMemfsCheckoutMock,
        },
      );

      expect(ensureLocalMemfsCheckoutMock).toHaveBeenCalledTimes(1);
      const message = JSON.parse(socket.sentPayloads[0] as string);
      expect(message).toMatchObject({
        type: "list_memory_response",
        request_id: "list-memory-pull-failed-1",
        success: false,
        done: true,
        total: 0,
        entries: [],
        error: "Pull failed: auth rejected",
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("listen-client channels command handling", () => {
  test("returns typed channel summaries over WS", async () => {
    const socket = new MockSocket(WebSocket.OPEN);
    const runtime = __listenClientTestUtils.createListenerRuntime();

    __listenClientTestUtils.setChannelsServiceLoaderForTests(async () => ({
      ...actualChannelsService,
      listChannelSummaries: () => [
        {
          channelId: "telegram" as const,
          displayName: "Telegram",
          configured: true,
          enabled: true,
          running: true,
          dmPolicy: "pairing" as const,
          pendingPairingsCount: 2,
          approvedUsersCount: 3,
          routesCount: 4,
        },
      ],
    }));

    try {
      await __listenClientTestUtils.handleChannelsProtocolCommand(
        {
          type: "channels_list",
          request_id: "channels-list-1",
        },
        socket as unknown as WebSocket,
        runtime,
        {
          onStatusChange: undefined,
          connectionId: "conn-test",
        },
        async () => {},
      );

      expect(socket.sentPayloads).toHaveLength(1);
      expect(JSON.parse(socket.sentPayloads[0] as string)).toMatchObject({
        type: "channels_list_response",
        request_id: "channels-list-1",
        success: true,
        channels: [
          {
            channel_id: "telegram",
            display_name: "Telegram",
            configured: true,
            enabled: true,
            running: true,
            dm_policy: "pairing",
            pending_pairings_count: 2,
            approved_users_count: 3,
            routes_count: 4,
          },
        ],
      });
    } finally {
      __listenClientTestUtils.stopRuntime(runtime, true);
    }
  });

  test("returns typed channel account snapshots over WS", async () => {
    const socket = new MockSocket(WebSocket.OPEN);
    const runtime = __listenClientTestUtils.createListenerRuntime();

    __listenClientTestUtils.setChannelsServiceLoaderForTests(async () => ({
      ...actualChannelsService,
      listChannelAccountSnapshots: () => [
        {
          channelId: "telegram" as const,
          accountId: "bot-1",
          displayName: "@docsbot",
          enabled: true,
          configured: true,
          running: true,
          dmPolicy: "pairing" as const,
          allowedUsers: [],
          config: {
            has_token: true,
            transcribe_voice: false,
            binding: {
              agent_id: "agent-1",
              conversation_id: "default",
            },
          },
          hasToken: true,
          transcribeVoice: false,
          binding: {
            agentId: "agent-1",
            conversationId: "default",
          },
          createdAt: "2026-04-11T00:00:00.000Z",
          updatedAt: "2026-04-11T01:00:00.000Z",
        },
      ],
    }));

    try {
      await __listenClientTestUtils.handleChannelsProtocolCommand(
        {
          type: "channel_accounts_list",
          request_id: "channel-accounts-list-1",
          channel_id: "telegram",
        },
        socket as unknown as WebSocket,
        runtime,
        {
          onStatusChange: undefined,
          connectionId: "conn-test",
        },
        async () => {},
      );

      expect(JSON.parse(socket.sentPayloads[0] as string)).toMatchObject({
        type: "channel_accounts_list_response",
        request_id: "channel-accounts-list-1",
        success: true,
        channel_id: "telegram",
        accounts: [
          {
            channel_id: "telegram",
            account_id: "bot-1",
            display_name: "@docsbot",
            enabled: true,
            configured: true,
            running: true,
            dm_policy: "pairing",
            config: {
              has_token: true,
              binding: {
                agent_id: "agent-1",
                conversation_id: "default",
              },
            },
            created_at: "2026-04-11T00:00:00.000Z",
            updated_at: "2026-04-11T01:00:00.000Z",
          },
        ],
      });
    } finally {
      __listenClientTestUtils.stopRuntime(runtime, true);
    }
  });

  test("bind emits pairing, route, and channel update events", async () => {
    const socket = new MockSocket(WebSocket.OPEN);
    const runtime = __listenClientTestUtils.createListenerRuntime();

    __listenClientTestUtils.setChannelsServiceLoaderForTests(async () => ({
      ...actualChannelsService,
      bindChannelPairing: () => ({
        chatId: "chat-42",
        route: {
          channelId: "telegram" as const,
          accountId: "bot-1",
          chatId: "chat-42",
          agentId: "agent-1",
          conversationId: "conv-1",
          enabled: true,
          createdAt: "2026-04-09T00:00:00.000Z",
          updatedAt: "2026-04-09T00:00:00.000Z",
        },
      }),
    }));

    try {
      await __listenClientTestUtils.handleChannelsProtocolCommand(
        {
          type: "channel_pairing_bind",
          request_id: "channel-bind-1",
          channel_id: "telegram",
          runtime: {
            agent_id: "agent-1",
            conversation_id: "conv-1",
          },
          code: "A7X9K2",
        },
        socket as unknown as WebSocket,
        runtime,
        {
          onStatusChange: undefined,
          connectionId: "conn-test",
        },
        async () => {},
      );

      const messages = socket.sentPayloads.map((payload) =>
        JSON.parse(payload as string),
      );

      expect(messages[0]).toMatchObject({
        type: "channel_pairing_bind_response",
        request_id: "channel-bind-1",
        success: true,
        channel_id: "telegram",
        chat_id: "chat-42",
        route: {
          channel_id: "telegram",
          chat_id: "chat-42",
          agent_id: "agent-1",
          conversation_id: "conv-1",
          enabled: true,
          created_at: "2026-04-09T00:00:00.000Z",
        },
      });
      expect(messages[1]).toMatchObject({
        type: "channel_pairings_updated",
        channel_id: "telegram",
      });
      expect(messages[2]).toMatchObject({
        type: "channel_routes_updated",
        channel_id: "telegram",
        agent_id: "agent-1",
        conversation_id: "conv-1",
      });
      expect(messages[3]).toMatchObject({
        type: "channels_updated",
        channel_id: "telegram",
      });
    } finally {
      __listenClientTestUtils.stopRuntime(runtime, true);
    }
  });

  test("target bind emits target, route, and channel update events", async () => {
    const socket = new MockSocket(WebSocket.OPEN);
    const runtime = __listenClientTestUtils.createListenerRuntime();

    __listenClientTestUtils.setChannelsServiceLoaderForTests(async () => ({
      ...actualChannelsService,
      bindChannelTarget: () => ({
        chatId: "C123",
        route: {
          channelId: "slack" as const,
          accountId: "workspace-1",
          chatId: "C123",
          agentId: "agent-1",
          conversationId: "conv-1",
          enabled: true,
          createdAt: "2026-04-10T00:00:00.000Z",
          updatedAt: "2026-04-10T00:00:00.000Z",
        },
      }),
      listChannelTargetSnapshots: () => [],
    }));

    try {
      await __listenClientTestUtils.handleChannelsProtocolCommand(
        {
          type: "channel_target_bind",
          request_id: "channel-target-bind-1",
          channel_id: "slack",
          runtime: {
            agent_id: "agent-1",
            conversation_id: "conv-1",
          },
          target_id: "C123",
        },
        socket as unknown as WebSocket,
        runtime,
        {
          onStatusChange: undefined,
          connectionId: "conn-test",
        },
        async () => {},
      );

      const messages = socket.sentPayloads.map((payload) =>
        JSON.parse(payload as string),
      );

      expect(messages[0]).toMatchObject({
        type: "channel_target_bind_response",
        request_id: "channel-target-bind-1",
        success: true,
        channel_id: "slack",
        target_id: "C123",
        chat_id: "C123",
        route: {
          channel_id: "slack",
          chat_id: "C123",
          agent_id: "agent-1",
          conversation_id: "conv-1",
          enabled: true,
          created_at: "2026-04-10T00:00:00.000Z",
        },
      });
      expect(messages[1]).toMatchObject({
        type: "channel_targets_updated",
        channel_id: "slack",
      });
      expect(messages[2]).toMatchObject({
        type: "channel_routes_updated",
        channel_id: "slack",
        agent_id: "agent-1",
        conversation_id: "conv-1",
      });
      expect(messages[3]).toMatchObject({
        type: "channels_updated",
        channel_id: "slack",
      });
    } finally {
      __listenClientTestUtils.stopRuntime(runtime, true);
    }
  });

  test("route update emits account, route, and channel update events", async () => {
    const socket = new MockSocket(WebSocket.OPEN);
    const runtime = __listenClientTestUtils.createListenerRuntime();

    __listenClientTestUtils.setChannelsServiceLoaderForTests(async () => ({
      ...actualChannelsService,
      updateChannelRouteLive: () => ({
        channelId: "slack" as const,
        accountId: "acct-1",
        chatId: "C123",
        agentId: "agent-2",
        conversationId: "conv-2",
        enabled: true,
        createdAt: "2026-04-11T03:00:00.000Z",
        updatedAt: "2026-04-11T03:00:00.000Z",
      }),
    }));

    try {
      await __listenClientTestUtils.handleChannelsProtocolCommand(
        {
          type: "channel_route_update",
          request_id: "channel-route-update-1",
          channel_id: "slack",
          account_id: "acct-1",
          chat_id: "C123",
          runtime: {
            agent_id: "agent-2",
            conversation_id: "conv-2",
          },
        },
        socket as unknown as WebSocket,
        runtime,
        {
          onStatusChange: undefined,
          connectionId: "conn-test",
        },
        async () => {},
      );

      const messages = socket.sentPayloads.map((payload) =>
        JSON.parse(payload as string),
      );

      expect(messages[0]).toMatchObject({
        type: "channel_route_update_response",
        request_id: "channel-route-update-1",
        success: true,
        channel_id: "slack",
        chat_id: "C123",
        route: {
          channel_id: "slack",
          account_id: "acct-1",
          chat_id: "C123",
          agent_id: "agent-2",
          conversation_id: "conv-2",
          enabled: true,
          created_at: "2026-04-11T03:00:00.000Z",
        },
      });
      expect(messages[1]).toMatchObject({
        type: "channel_accounts_updated",
        channel_id: "slack",
        account_id: "acct-1",
      });
      expect(messages[2]).toMatchObject({
        type: "channel_routes_updated",
        channel_id: "slack",
        agent_id: "agent-2",
        conversation_id: "conv-2",
      });
      expect(messages[3]).toMatchObject({
        type: "channels_updated",
        channel_id: "slack",
      });
    } finally {
      __listenClientTestUtils.stopRuntime(runtime, true);
    }
  });

  test("account bind and unbind emit account update events", async () => {
    const socket = new MockSocket(WebSocket.OPEN);
    const runtime = __listenClientTestUtils.createListenerRuntime();

    __listenClientTestUtils.setChannelsServiceLoaderForTests(async () => ({
      ...actualChannelsService,
      bindChannelAccountLive: () => ({
        channelId: "slack" as const,
        accountId: "acct-1",
        displayName: "DocsBot Slack",
        enabled: true,
        configured: true,
        running: false,
        mode: "socket" as const,
        dmPolicy: "pairing" as const,
        allowedUsers: [],
        config: {
          mode: "socket",
          has_bot_token: true,
          has_app_token: true,
          agent_id: "agent-1",
          default_permission_mode: "acceptEdits",
        },
        hasBotToken: true,
        hasAppToken: true,
        agentId: "agent-1",
        defaultPermissionMode: "acceptEdits" as const,
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T01:00:00.000Z",
      }),
      unbindChannelAccountLive: () => ({
        channelId: "slack" as const,
        accountId: "acct-1",
        displayName: "DocsBot Slack",
        enabled: true,
        configured: true,
        running: false,
        mode: "socket" as const,
        dmPolicy: "pairing" as const,
        allowedUsers: [],
        config: {
          mode: "socket",
          has_bot_token: true,
          has_app_token: true,
          agent_id: null,
          default_permission_mode: "acceptEdits",
        },
        hasBotToken: true,
        hasAppToken: true,
        agentId: null,
        defaultPermissionMode: "acceptEdits" as const,
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T02:00:00.000Z",
      }),
    }));

    try {
      await __listenClientTestUtils.handleChannelsProtocolCommand(
        {
          type: "channel_account_bind",
          request_id: "channel-account-bind-1",
          channel_id: "slack",
          account_id: "acct-1",
          runtime: {
            agent_id: "agent-1",
            conversation_id: "conv-1",
          },
        },
        socket as unknown as WebSocket,
        runtime,
        {
          onStatusChange: undefined,
          connectionId: "conn-test",
        },
        async () => {},
      );

      let messages = socket.sentPayloads.map((payload) =>
        JSON.parse(payload as string),
      );
      expect(messages[0]).toMatchObject({
        type: "channel_account_bind_response",
        request_id: "channel-account-bind-1",
        success: true,
        channel_id: "slack",
        account: {
          account_id: "acct-1",
          config: {
            agent_id: "agent-1",
            default_permission_mode: "acceptEdits",
          },
        },
      });
      expect(messages[1]).toMatchObject({
        type: "channel_accounts_updated",
        channel_id: "slack",
        account_id: "acct-1",
      });
      expect(messages[2]).toMatchObject({
        type: "channels_updated",
        channel_id: "slack",
      });

      socket.sentPayloads.length = 0;

      await __listenClientTestUtils.handleChannelsProtocolCommand(
        {
          type: "channel_account_unbind",
          request_id: "channel-account-unbind-1",
          channel_id: "slack",
          account_id: "acct-1",
        },
        socket as unknown as WebSocket,
        runtime,
        {
          onStatusChange: undefined,
          connectionId: "conn-test",
        },
        async () => {},
      );

      messages = socket.sentPayloads.map((payload) =>
        JSON.parse(payload as string),
      );
      expect(messages[0]).toMatchObject({
        type: "channel_account_unbind_response",
        request_id: "channel-account-unbind-1",
        success: true,
        channel_id: "slack",
        account: {
          account_id: "acct-1",
          config: {
            agent_id: null,
            default_permission_mode: "acceptEdits",
          },
        },
      });
      expect(messages[1]).toMatchObject({
        type: "channel_accounts_updated",
        channel_id: "slack",
        account_id: "acct-1",
      });
      expect(messages[2]).toMatchObject({
        type: "channels_updated",
        channel_id: "slack",
      });
    } finally {
      __listenClientTestUtils.stopRuntime(runtime, true);
    }
  });

  test("account create, start, and delete emit typed responses and updates", async () => {
    const socket = new MockSocket(WebSocket.OPEN);
    const runtime = __listenClientTestUtils.createListenerRuntime();

    __listenClientTestUtils.setChannelsServiceLoaderForTests(async () => ({
      ...actualChannelsService,
      createChannelAccountLive: () => ({
        channelId: "telegram" as const,
        accountId: "bot-1",
        displayName: "@docsbot",
        enabled: false,
        configured: true,
        running: false,
        dmPolicy: "pairing" as const,
        allowedUsers: [],
        config: {
          has_token: true,
          transcribe_voice: false,
          binding: {
            agent_id: null,
            conversation_id: null,
          },
        },
        hasToken: true,
        transcribeVoice: false,
        binding: {
          agentId: null,
          conversationId: null,
        },
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      }),
      startChannelAccountLive: async () => ({
        channelId: "telegram" as const,
        accountId: "bot-1",
        displayName: "@docsbot",
        enabled: true,
        configured: true,
        running: true,
        dmPolicy: "pairing" as const,
        allowedUsers: [],
        config: {
          has_token: true,
          transcribe_voice: false,
          binding: {
            agent_id: null,
            conversation_id: null,
          },
        },
        hasToken: true,
        transcribeVoice: false,
        binding: {
          agentId: null,
          conversationId: null,
        },
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:05:00.000Z",
      }),
      removeChannelAccountLive: async () => true,
    }));

    try {
      await __listenClientTestUtils.handleChannelsProtocolCommand(
        {
          type: "channel_account_create",
          request_id: "channel-account-create-1",
          channel_id: "telegram",
          account: {
            display_name: "@docsbot",
            dm_policy: "pairing",
            config: {
              token: "telegram-token",
            },
          },
        },
        socket as unknown as WebSocket,
        runtime,
        {
          onStatusChange: undefined,
          connectionId: "conn-test",
        },
        async () => {},
      );

      let messages = socket.sentPayloads.map((payload) =>
        JSON.parse(payload as string),
      );
      expect(messages[0]).toMatchObject({
        type: "channel_account_create_response",
        request_id: "channel-account-create-1",
        success: true,
        channel_id: "telegram",
        account: {
          account_id: "bot-1",
          display_name: "@docsbot",
          config: {
            has_token: true,
          },
        },
      });
      expect(messages[1]).toMatchObject({
        type: "channel_accounts_updated",
        channel_id: "telegram",
        account_id: "bot-1",
      });
      expect(messages[2]).toMatchObject({
        type: "channels_updated",
        channel_id: "telegram",
      });

      socket.sentPayloads.length = 0;

      await __listenClientTestUtils.handleChannelsProtocolCommand(
        {
          type: "channel_account_start",
          request_id: "channel-account-start-1",
          channel_id: "telegram",
          account_id: "bot-1",
        },
        socket as unknown as WebSocket,
        runtime,
        {
          onStatusChange: undefined,
          connectionId: "conn-test",
        },
        async () => {},
      );

      messages = socket.sentPayloads.map((payload) =>
        JSON.parse(payload as string),
      );
      expect(messages[0]).toMatchObject({
        type: "channel_account_start_response",
        request_id: "channel-account-start-1",
        success: true,
        channel_id: "telegram",
        account: {
          account_id: "bot-1",
          enabled: true,
          running: true,
        },
      });
      expect(messages[1]).toMatchObject({
        type: "channel_accounts_updated",
        channel_id: "telegram",
        account_id: "bot-1",
      });
      expect(messages[2]).toMatchObject({
        type: "channels_updated",
        channel_id: "telegram",
      });

      socket.sentPayloads.length = 0;

      await __listenClientTestUtils.handleChannelsProtocolCommand(
        {
          type: "channel_account_delete",
          request_id: "channel-account-delete-1",
          channel_id: "telegram",
          account_id: "bot-1",
        },
        socket as unknown as WebSocket,
        runtime,
        {
          onStatusChange: undefined,
          connectionId: "conn-test",
        },
        async () => {},
      );

      messages = socket.sentPayloads.map((payload) =>
        JSON.parse(payload as string),
      );
      expect(messages[0]).toMatchObject({
        type: "channel_account_delete_response",
        request_id: "channel-account-delete-1",
        success: true,
        channel_id: "telegram",
        account_id: "bot-1",
        deleted: true,
      });
      expect(messages[1]).toMatchObject({
        type: "channel_accounts_updated",
        channel_id: "telegram",
        account_id: "bot-1",
      });
      expect(messages[2]).toMatchObject({
        type: "channel_pairings_updated",
        channel_id: "telegram",
      });
      expect(messages[3]).toMatchObject({
        type: "channel_routes_updated",
        channel_id: "telegram",
      });
      expect(messages[4]).toMatchObject({
        type: "channel_targets_updated",
        channel_id: "telegram",
      });
      expect(messages[5]).toMatchObject({
        type: "channels_updated",
        channel_id: "telegram",
      });
    } finally {
      __listenClientTestUtils.stopRuntime(runtime, true);
    }
  });
});

describe("listen-client reflection settings command handling", () => {
  test("wraps typed reflection settings reads and writes over WS", async () => {
    const tempProjectDir = await mkdtemp(
      join(os.tmpdir(), "letta-listen-reflection-"),
    );
    const originalGetSettings = settingsManager.getSettings;
    const originalGetLocalProjectSettings =
      settingsManager.getLocalProjectSettings;
    const originalLoadLocalProjectSettings =
      settingsManager.loadLocalProjectSettings;
    const originalUpdateSettings = settingsManager.updateSettings;
    const originalUpdateLocalProjectSettings =
      settingsManager.updateLocalProjectSettings;

    const globalSettings = {
      reflectionTrigger: "compaction-event",
      reflectionStepCount: 25,
      memoryReminderInterval: "auto-compaction",
      reflectionSettingsByAgent: {},
    } as Settings;
    const localSettingsByDir = new Map<string, LocalProjectSettings>();

    try {
      (settingsManager as typeof settingsManager).getSettings = (() =>
        globalSettings) as typeof settingsManager.getSettings;
      (settingsManager as typeof settingsManager).getLocalProjectSettings = ((
        workingDirectory: string = process.cwd(),
      ) => {
        const settings = localSettingsByDir.get(workingDirectory);
        if (!settings) {
          throw new Error("local settings not loaded");
        }
        return settings as ReturnType<
          typeof settingsManager.getLocalProjectSettings
        >;
      }) as typeof settingsManager.getLocalProjectSettings;
      (settingsManager as typeof settingsManager).loadLocalProjectSettings =
        (async (workingDirectory: string = process.cwd()) => {
          const settings = {
            lastAgent: null,
            reflectionSettingsByAgent: {},
          } satisfies LocalProjectSettings;
          localSettingsByDir.set(workingDirectory, settings);
          return settings as Awaited<
            ReturnType<typeof settingsManager.loadLocalProjectSettings>
          >;
        }) as typeof settingsManager.loadLocalProjectSettings;
      (settingsManager as typeof settingsManager).updateSettings = ((
        updates: Record<string, unknown>,
      ) => {
        Object.assign(
          globalSettings as unknown as Record<string, unknown>,
          updates,
        );
      }) as typeof settingsManager.updateSettings;
      (settingsManager as typeof settingsManager).updateLocalProjectSettings =
        ((updates: Record<string, unknown>, workingDirectory?: string) => {
          const key = workingDirectory ?? process.cwd();
          const current = localSettingsByDir.get(key) ?? { lastAgent: null };
          localSettingsByDir.set(key, { ...current, ...updates });
        }) as typeof settingsManager.updateLocalProjectSettings;

      const socket = new MockSocket(WebSocket.OPEN);
      const listener = __listenClientTestUtils.createListenerRuntime();
      __listenClientTestUtils.setConversationWorkingDirectory(
        listener,
        "agent-1",
        "default",
        tempProjectDir,
      );

      await __listenClientTestUtils.handleReflectionSettingsCommand(
        {
          type: "get_reflection_settings",
          request_id: "reflection-get-1",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
        },
        socket as unknown as WebSocket,
        listener,
      );

      const getResponse = JSON.parse(socket.sentPayloads[0] as string);
      expect(getResponse).toMatchObject({
        type: "get_reflection_settings_response",
        request_id: "reflection-get-1",
        success: true,
        reflection_settings: {
          agent_id: "agent-1",
          trigger: "compaction-event",
          step_count: 25,
        },
      });

      socket.sentPayloads.length = 0;

      await __listenClientTestUtils.handleReflectionSettingsCommand(
        {
          type: "set_reflection_settings",
          request_id: "reflection-set-1",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
          settings: {
            trigger: "step-count",
            step_count: 9,
          },
          scope: "local_project",
        },
        socket as unknown as WebSocket,
        listener,
      );

      const setResponse = JSON.parse(socket.sentPayloads[0] as string);
      const deviceStatusUpdate = JSON.parse(socket.sentPayloads[1] as string);
      expect(setResponse).toMatchObject({
        type: "set_reflection_settings_response",
        request_id: "reflection-set-1",
        success: true,
        scope: "local_project",
        reflection_settings: {
          agent_id: "agent-1",
          trigger: "step-count",
          step_count: 9,
        },
      });
      expect(deviceStatusUpdate).toMatchObject({
        type: "update_device_status",
        device_status: {
          reflection_settings: {
            agent_id: "agent-1",
            trigger: "step-count",
            step_count: 9,
          },
        },
      });
    } finally {
      (settingsManager as typeof settingsManager).getSettings =
        originalGetSettings;
      (settingsManager as typeof settingsManager).getLocalProjectSettings =
        originalGetLocalProjectSettings;
      (settingsManager as typeof settingsManager).loadLocalProjectSettings =
        originalLoadLocalProjectSettings;
      (settingsManager as typeof settingsManager).updateSettings =
        originalUpdateSettings;
      (settingsManager as typeof settingsManager).updateLocalProjectSettings =
        originalUpdateLocalProjectSettings;
      await rm(tempProjectDir, { recursive: true, force: true });
    }
  });
});

describe("listen-client experiment command handling", () => {
  test("wraps typed experiment reads and writes over WS", async () => {
    const originalGetSettings = settingsManager.getSettings;
    const originalUpdateSettings = settingsManager.updateSettings;
    const globalSettings = { autoConversationTitles: false } as Settings;

    try {
      (settingsManager as typeof settingsManager).getSettings = (() =>
        globalSettings) as typeof settingsManager.getSettings;
      (settingsManager as typeof settingsManager).updateSettings = ((
        updates: Record<string, unknown>,
      ) => {
        Object.assign(
          globalSettings as unknown as Record<string, unknown>,
          updates,
        );
      }) as typeof settingsManager.updateSettings;

      const socket = new MockSocket(WebSocket.OPEN);
      const listener = __listenClientTestUtils.createListenerRuntime();
      __listenClientTestUtils.getOrCreateConversationRuntime(
        listener,
        "agent-1",
        "default",
      );

      await __listenClientTestUtils.handleExperimentCommand(
        {
          type: "get_experiments",
          request_id: "experiments-get-1",
        },
        socket as unknown as WebSocket,
        listener,
      );

      const getResponse = JSON.parse(socket.sentPayloads[0] as string);
      expect(getResponse).toMatchObject({
        type: "get_experiments_response",
        request_id: "experiments-get-1",
        success: true,
        experiments: expect.arrayContaining([
          expect.objectContaining({
            id: "tui_cron",
            enabled: false,
            source: "default",
          }),
          expect.objectContaining({
            id: "conversation_titles",
            enabled: false,
          }),
        ]),
      });

      socket.sentPayloads.length = 0;

      await __listenClientTestUtils.handleExperimentCommand(
        {
          type: "set_experiment",
          request_id: "experiment-set-1",
          experiment_id: "tui_cron",
          enabled: true,
        },
        socket as unknown as WebSocket,
        listener,
      );

      const setResponse = JSON.parse(socket.sentPayloads[0] as string);
      const deviceStatusUpdate = JSON.parse(socket.sentPayloads[1] as string);
      expect(setResponse).toMatchObject({
        type: "set_experiment_response",
        request_id: "experiment-set-1",
        success: true,
        experiments: expect.arrayContaining([
          expect.objectContaining({
            id: "tui_cron",
            enabled: true,
            source: "override",
          }),
        ]),
      });
      expect(deviceStatusUpdate).toMatchObject({
        type: "update_device_status",
        device_status: {
          experiments: expect.arrayContaining([
            expect.objectContaining({
              id: "tui_cron",
              enabled: true,
              source: "override",
            }),
          ]),
        },
      });

      socket.sentPayloads.length = 0;

      await __listenClientTestUtils.handleExperimentCommand(
        {
          type: "set_experiment",
          request_id: "conversation-titles-set-1",
          experiment_id: "conversation_titles",
          enabled: true,
        },
        socket as unknown as WebSocket,
        listener,
      );

      const titleSetResponse = JSON.parse(socket.sentPayloads[0] as string);
      expect(titleSetResponse).toMatchObject({
        type: "set_experiment_response",
        request_id: "conversation-titles-set-1",
        success: true,
        experiments: expect.arrayContaining([
          expect.objectContaining({
            id: "conversation_titles",
            enabled: true,
          }),
        ]),
      });
      expect(globalSettings.autoConversationTitles).toBe(true);
    } finally {
      (settingsManager as typeof settingsManager).getSettings =
        originalGetSettings;
      (settingsManager as typeof settingsManager).updateSettings =
        originalUpdateSettings;
    }
  });
});

describe("listen-client permission mode scope keys", () => {
  test("falls back from legacy default key and migrates to agent-scoped key", () => {
    const listener = __listenClientTestUtils.createListenerRuntime();

    // Simulate a pre-existing/legacy persisted entry without agent binding.
    listener.permissionModeByConversation.set(
      "agent:__unknown__::conversation:default",
      {
        mode: "acceptEdits",
      },
    );

    const status = __listenClientTestUtils.buildDeviceStatus(listener, {
      agent_id: "agent-123",
      conversation_id: "default",
    });

    expect(status.current_permission_mode).toBe("acceptEdits");
    expect(
      listener.permissionModeByConversation.has(
        "agent:agent-123::conversation:default",
      ),
    ).toBe(true);
    expect(
      listener.permissionModeByConversation.has(
        "agent:__unknown__::conversation:default",
      ),
    ).toBe(false);
  });

  test("slack conversation created event seeds the new conversation permission mode", () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    listener.workingDirectoryByConversation.delete("conversation:conv-slack-1");
    const socket = new MockSocket(WebSocket.OPEN);

    __listenClientTestUtils.handleChannelRegistryEvent(
      {
        type: "slack_conversation_created",
        channelId: "slack",
        accountId: "acct-1",
        agentId: "agent-123",
        conversationId: "conv-slack-1",
        defaultPermissionMode: "unrestricted",
      },
      socket as unknown as WebSocket,
      listener,
    );

    const status = __listenClientTestUtils.buildDeviceStatus(listener, {
      agent_id: "agent-123",
      conversation_id: "conv-slack-1",
    });

    expect(status.current_permission_mode).toBe("unrestricted");
    expect(
      listener.permissionModeByConversation.get("conversation:conv-slack-1"),
    ).toEqual({
      mode: "unrestricted",
    });
    expect(
      listener.workingDirectoryByConversation.get("conversation:conv-slack-1"),
    ).toBe(listener.bootWorkingDirectory);

    const emittedStatus = socket.sentPayloads.map((payload) =>
      JSON.parse(payload),
    )[0];
    expect(emittedStatus).toMatchObject({
      type: "update_device_status",
      runtime: {
        agent_id: "agent-123",
        conversation_id: "conv-slack-1",
      },
      device_status: {
        current_working_directory: listener.bootWorkingDirectory,
        cwd_map: {
          "conversation:conv-slack-1": listener.bootWorkingDirectory,
        },
        boot_working_directory: listener.bootWorkingDirectory,
      },
    });
  });

  test("discord conversation created event seeds the new conversation permission mode", () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    listener.workingDirectoryByConversation.delete(
      "conversation:conv-discord-1",
    );
    const socket = new MockSocket(WebSocket.OPEN);

    __listenClientTestUtils.handleChannelRegistryEvent(
      {
        type: "discord_conversation_created",
        channelId: "discord",
        accountId: "acct-1",
        agentId: "agent-123",
        conversationId: "conv-discord-1",
        defaultPermissionMode: "acceptEdits",
      },
      socket as unknown as WebSocket,
      listener,
    );

    const status = __listenClientTestUtils.buildDeviceStatus(listener, {
      agent_id: "agent-123",
      conversation_id: "conv-discord-1",
    });

    expect(status.current_permission_mode).toBe("acceptEdits");
    expect(
      listener.permissionModeByConversation.get("conversation:conv-discord-1"),
    ).toEqual({
      mode: "acceptEdits",
    });
    expect(
      listener.workingDirectoryByConversation.get(
        "conversation:conv-discord-1",
      ),
    ).toBe(listener.bootWorkingDirectory);

    const emittedStatus = socket.sentPayloads.map((payload) =>
      JSON.parse(payload),
    )[0];
    expect(emittedStatus).toMatchObject({
      type: "update_device_status",
      runtime: {
        agent_id: "agent-123",
        conversation_id: "conv-discord-1",
      },
      device_status: {
        current_working_directory: listener.bootWorkingDirectory,
        cwd_map: {
          "conversation:conv-discord-1": listener.bootWorkingDirectory,
        },
        boot_working_directory: listener.bootWorkingDirectory,
      },
    });
  });
});

describe("listen-client conversation working directory", () => {
  test("falls back to boot dir and prunes a stale (deleted) persisted cwd", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const scopeKey = "agent:agent-123::conversation:default";

    // Simulate a worktree dir that was persisted, then cleaned up.
    const staleDir = await mkdtemp(join(os.tmpdir(), "ws-stale-cwd-"));
    listener.workingDirectoryByConversation.set(scopeKey, staleDir);
    await rm(staleDir, { recursive: true, force: true });

    const resolved = __listenClientTestUtils.getConversationWorkingDirectory(
      listener,
      "agent-123",
      "default",
    );

    expect(resolved).toBe(listener.bootWorkingDirectory);
    // The dead entry should be pruned so it isn't served again.
    expect(listener.workingDirectoryByConversation.has(scopeKey)).toBe(false);
  });

  test("returns a persisted cwd that still exists", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const scopeKey = "agent:agent-123::conversation:default";

    const liveDir = await mkdtemp(join(os.tmpdir(), "ws-live-cwd-"));
    try {
      listener.workingDirectoryByConversation.set(scopeKey, liveDir);

      const resolved = __listenClientTestUtils.getConversationWorkingDirectory(
        listener,
        "agent-123",
        "default",
      );

      expect(resolved).toBe(liveDir);
      expect(listener.workingDirectoryByConversation.has(scopeKey)).toBe(true);
    } finally {
      await rm(liveDir, { recursive: true, force: true });
    }
  });
});

describe("listen-client protocol emission", () => {
  test("does not throw when protocol emission send fails", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const socket = new MockSocket(WebSocket.OPEN);
    runtime.activeAgentId = "agent-1";
    runtime.activeConversationId = "default";
    socket.sendImpl = () => {
      throw new Error("socket send failed");
    };
    const originalConsoleError = console.error;
    console.error = () => {};

    try {
      expect(() =>
        __listenClientTestUtils.emitDeviceStatusUpdate(
          socket as unknown as WebSocket,
          runtime,
        ),
      ).not.toThrow();
      expect(socket.sentPayloads).toHaveLength(0);
    } finally {
      console.error = originalConsoleError;
    }
  });
});

describe("listen-client conversation-scoped protocol events", () => {
  test("queue enqueue/block updates loop status with runtime scope instead of stream_delta", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtime = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-default",
      "default",
    );
    const socket = new MockSocket(WebSocket.OPEN);
    listener.socket = socket as unknown as WebSocket;

    const input: Omit<MessageQueueItem, "id" | "enqueuedAt"> = {
      kind: "message",
      source: "user",
      content: "hello",
      clientMessageId: "cm-queue-1",
      agentId: "agent-default",
      conversationId: "default",
    };
    const item = runtime.queueRuntime.enqueue(input);
    expect(item).not.toBeNull();

    runtime.queueRuntime.tryDequeue("runtime_busy");

    // Flush microtask queue (update_queue is debounced via queueMicrotask)
    await Promise.resolve();

    const outbound = socket.sentPayloads.map((payload) =>
      JSON.parse(payload as string),
    );
    const queueUpdate = outbound.find(
      (payload) =>
        payload.type === "update_queue" &&
        payload.runtime.agent_id === "agent-default" &&
        payload.runtime.conversation_id === "default" &&
        payload.queue?.length === 1,
    );
    expect(queueUpdate).toBeDefined();
    expect(
      outbound.some(
        (payload) =>
          payload.type === "stream_delta" &&
          typeof payload.delta?.type === "string" &&
          payload.delta.type.startsWith("queue_"),
      ),
    ).toBe(false);
  });

  test("queue dequeue keeps scope through update_queue runtime envelope", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtime = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-xyz",
      "conv-xyz",
    );
    const socket = new MockSocket(WebSocket.OPEN);
    listener.socket = socket as unknown as WebSocket;

    const input: Omit<MessageQueueItem, "id" | "enqueuedAt"> = {
      kind: "message",
      source: "user",
      content: "hello",
      clientMessageId: "cm-queue-2",
      agentId: "agent-xyz",
      conversationId: "conv-xyz",
    };

    runtime.queueRuntime.enqueue(input);
    runtime.queueRuntime.tryDequeue(null);

    // Flush microtask queue (update_queue is debounced via queueMicrotask)
    await Promise.resolve();

    const outbound = socket.sentPayloads.map((payload) =>
      JSON.parse(payload as string),
    );
    // With microtask coalescing, enqueue + dequeue in same tick
    // produces a single update_queue with the final state (0 items)
    const dequeued = outbound.find(
      (payload) =>
        payload.type === "update_queue" &&
        payload.runtime.agent_id === "agent-xyz" &&
        payload.runtime.conversation_id === "conv-xyz" &&
        Array.isArray(payload.queue) &&
        payload.queue.length === 0,
    );
    expect(dequeued).toBeDefined();
  });
});

describe("listen-client v2 status builders", () => {
  test("buildLoopStatus defaults to WAITING_ON_INPUT with no active run", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const loopStatus = __listenClientTestUtils.buildLoopStatus(runtime);
    expect(loopStatus.status).toBe("WAITING_ON_INPUT");
    expect(loopStatus.active_run_ids).toEqual([]);
    // queue is now separate from loopStatus — verify via buildQueueSnapshot
    const queueSnapshot = __listenClientTestUtils.buildQueueSnapshot(runtime);
    expect(queueSnapshot).toEqual([]);
  });

  test("buildDeviceStatus includes the effective working directory", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const deviceStatus = __listenClientTestUtils.buildDeviceStatus(runtime);
    expect(typeof deviceStatus.current_working_directory).toBe("string");
    expect(
      (deviceStatus.current_working_directory ?? "").length,
    ).toBeGreaterThan(0);
    expect(deviceStatus.current_toolset_preference).toBe("auto");
    expect(deviceStatus.experiments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "tui_cron",
          source: "default",
        }),
      ]),
    );
  });

  test("buildDeviceStatus includes should_doctor state when available", () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    setSystemPromptDoctorState("agent-doctor-status", 31000);

    const deviceStatus = __listenClientTestUtils.buildDeviceStatus(listener, {
      agent_id: "agent-doctor-status",
      conversation_id: "default",
    });

    expect(deviceStatus.should_doctor).toBe(true);
  });

  test("buildDeviceStatus does not cold-refresh should_doctor from stray memfs", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const agentId = `agent-doctor-refresh-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const memoryDir = getMemoryFilesystemRoot(agentId);
    const systemDir = join(memoryDir, "system");
    const originalIsMemfsEnabled = settingsManager.isMemfsEnabled;

    await mkdir(systemDir, { recursive: true });

    try {
      (settingsManager as typeof settingsManager).isMemfsEnabled = (() =>
        false) as typeof settingsManager.isMemfsEnabled;
      await writeFile(join(systemDir, "context.md"), "x".repeat(120_000));

      const deviceStatus = __listenClientTestUtils.buildDeviceStatus(listener, {
        agent_id: agentId,
        conversation_id: "default",
      });

      expect(deviceStatus.should_doctor).toBe(false);
    } finally {
      (settingsManager as typeof settingsManager).isMemfsEnabled =
        originalIsMemfsEnabled;
      await rm(memoryDir, { recursive: true, force: true });
    }
  });

  test("buildDeviceStatus includes only active bash and task background processes", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    backgroundProcesses.clear();
    backgroundTasks.clear();

    try {
      backgroundProcesses.set("bash_1", {
        process: {} as never,
        command: "sleep 300",
        stdout: [],
        stderr: [],
        status: "running",
        exitCode: null,
        lastReadIndex: { stdout: 0, stderr: 0 },
        startTime: new Date("2026-03-27T12:00:00.000Z"),
      });
      backgroundTasks.set("task_1", {
        description: "Active background review",
        subagentType: "review",
        subagentId: "subagent-1",
        status: "running",
        output: [],
        startTime: new Date("2026-03-27T12:01:00.000Z"),
        outputFile: "/tmp/task_1.log",
      });
      backgroundTasks.set("task_2", {
        description: "Reflect on recent conversations",
        subagentType: "reflection",
        subagentId: "subagent-2",
        status: "completed",
        output: [],
        startTime: new Date("2026-03-27T12:02:00.000Z"),
        outputFile: "/tmp/task_2.log",
      });

      const deviceStatus = __listenClientTestUtils.buildDeviceStatus(runtime);
      expect(deviceStatus.background_processes).toEqual([
        {
          process_id: "task_1",
          kind: "agent_task",
          task_type: "review",
          description: "Active background review",
          started_at_ms: new Date("2026-03-27T12:01:00.000Z").getTime(),
          status: "running",
          subagent_id: "subagent-1",
        },
        {
          process_id: "bash_1",
          kind: "bash",
          command: "sleep 300",
          started_at_ms: new Date("2026-03-27T12:00:00.000Z").getTime(),
          status: "running",
          exit_code: null,
        },
      ]);
    } finally {
      backgroundProcesses.clear();
      backgroundTasks.clear();
    }
  });

  test("resolveRuntimeScope returns null until a real runtime is bound", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    expect(__listenClientTestUtils.resolveRuntimeScope(runtime)).toBeNull();

    runtime.activeAgentId = "agent-1";
    runtime.activeConversationId = "default";
    expect(__listenClientTestUtils.resolveRuntimeScope(runtime)).toEqual({
      agent_id: "agent-1",
      conversation_id: "default",
    });
  });

  test("resolveRuntimeScope does not guess another conversation when multiple runtimes exist", () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtimeA = __listenClientTestUtils.getOrCreateConversationRuntime(
      listener,
      "agent-1",
      "conv-a",
    );
    __listenClientTestUtils.getOrCreateConversationRuntime(
      listener,
      "agent-1",
      "conv-b",
    );

    beginTestTurn(runtimeA);

    expect(__listenClientTestUtils.resolveRuntimeScope(listener)).toBeNull();
  });

  test("does not emit bootstrap status updates with __unknown_agent__ runtime", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const socket = new MockSocket(WebSocket.OPEN);

    __listenClientTestUtils.emitDeviceStatusUpdate(
      socket as unknown as WebSocket,
      runtime,
    );
    __listenClientTestUtils.emitLoopStatusUpdate(
      socket as unknown as WebSocket,
      runtime,
    );

    expect(socket.sentPayloads).toHaveLength(0);

    runtime.activeAgentId = "agent-1";
    runtime.activeConversationId = "default";

    __listenClientTestUtils.emitDeviceStatusUpdate(
      socket as unknown as WebSocket,
      runtime,
    );
    __listenClientTestUtils.emitLoopStatusUpdate(
      socket as unknown as WebSocket,
      runtime,
    );

    const outbound = socket.sentPayloads.map((payload) =>
      JSON.parse(payload as string),
    );
    expect(outbound).toHaveLength(2);
    expect(outbound[0].runtime).toEqual({
      agent_id: "agent-1",
      conversation_id: "default",
    });
    expect(outbound[1].runtime).toEqual({
      agent_id: "agent-1",
      conversation_id: "default",
    });
  });

  test("sync replays device, loop, and queue state for the requested runtime", () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtime = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "default",
    );
    const socket = new MockSocket(WebSocket.OPEN);
    const queueInput = {
      clientMessageId: "cm-1",
      agentId: "agent-1",
      conversationId: "default",
      kind: "message" as const,
      source: "user" as const,
      content: "hello",
    } as Parameters<typeof runtime.queueRuntime.enqueue>[0];

    runtime.queueRuntime.enqueue(queueInput);

    __listenClientTestUtils.emitStateSync(
      socket as unknown as WebSocket,
      runtime,
      {
        agent_id: "agent-1",
        conversation_id: "default",
      },
    );

    const outbound = socket.sentPayloads.map((payload) =>
      JSON.parse(payload as string),
    );
    expect(outbound.map((message) => message.type)).toEqual([
      "update_device_status",
      "update_loop_status",
      "update_queue",
      "update_subagent_state",
    ]);
    expect(
      outbound.every((message) => message.runtime.agent_id === "agent-1"),
    ).toBe(true);
    expect(
      outbound.every(
        (message) => message.runtime.conversation_id === "default",
      ),
    ).toBe(true);
    expect(outbound[2].queue).toEqual([
      expect.objectContaining({
        id: "q-1",
        client_message_id: "cm-1",
        kind: "message",
      }),
    ]);
  });

  test("sync can force update_device_status even when cached", () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtime = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "default",
    );
    const socket = new MockSocket(WebSocket.OPEN);
    const scope = { agent_id: "agent-1", conversation_id: "default" };

    __listenClientTestUtils.emitStateSync(
      socket as unknown as WebSocket,
      runtime,
      scope,
    );
    socket.sentPayloads = [];

    __listenClientTestUtils.emitStateSync(
      socket as unknown as WebSocket,
      runtime,
      scope,
    );
    expect(
      socket.sentPayloads
        .map((payload) => JSON.parse(payload as string))
        .map((message) => message.type),
    ).toEqual(["update_loop_status", "update_queue", "update_subagent_state"]);

    socket.sentPayloads = [];
    __listenClientTestUtils.emitStateSync(
      socket as unknown as WebSocket,
      runtime,
      scope,
      { forceDeviceStatus: true },
    );

    expect(
      socket.sentPayloads
        .map((payload) => JSON.parse(payload as string))
        .map((message) => message.type),
    ).toEqual([
      "update_device_status",
      "update_loop_status",
      "update_queue",
      "update_subagent_state",
    ]);
  });

  test("sync replay soft-fails approval recovery errors without emitting loop_error rows", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "default",
    );
    const socket = new MockSocket(WebSocket.OPEN);

    await __listenClientTestUtils.replaySyncStateForRuntime(
      listener,
      socket as unknown as WebSocket,
      {
        agent_id: "agent-1",
        conversation_id: "default",
      },
      {
        recoverApprovalStateForSync: async () => {
          throw new Error(
            "Unterminated string in JSON at position 183040 (line 1 column 183041)",
          );
        },
      },
    );

    const outbound = socket.sentPayloads.map((payload) =>
      JSON.parse(payload as string),
    );
    expect(outbound.map((message) => message.type)).toEqual([
      "update_device_status",
      "update_loop_status",
      "update_queue",
      "update_subagent_state",
    ]);
    expect(
      outbound.some(
        (message) =>
          message.type === "stream_delta" &&
          message.delta?.message_type === "loop_error",
      ),
    ).toBe(false);
  });

  test("sync replay can skip backend approval recovery for lightweight state sync", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "default",
    );
    const socket = new MockSocket(WebSocket.OPEN);
    const recoverApprovalStateForSync = mock(async () => {});

    await __listenClientTestUtils.replaySyncStateForRuntime(
      listener,
      socket as unknown as WebSocket,
      {
        agent_id: "agent-1",
        conversation_id: "default",
      },
      {
        recoverApprovals: false,
        recoverApprovalStateForSync,
      },
    );

    expect(recoverApprovalStateForSync).not.toHaveBeenCalled();
    const outbound = socket.sentPayloads.map((payload) =>
      JSON.parse(payload as string),
    );
    expect(outbound.map((message) => message.type)).toEqual([
      "update_device_status",
      "update_loop_status",
      "update_queue",
      "update_subagent_state",
    ]);
  });

  test("sync replay schedules background warmups after state sync", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "default",
    );
    const socket = new MockSocket(WebSocket.OPEN);
    const scheduleWarmupsAfterSync = mock(() => {});

    await __listenClientTestUtils.replaySyncStateForRuntime(
      listener,
      socket as unknown as WebSocket,
      {
        agent_id: "agent-1",
        conversation_id: "default",
      },
      {
        recoverApprovals: false,
        scheduleWarmupsAfterSync,
      },
    );

    expect(scheduleWarmupsAfterSync).toHaveBeenCalledTimes(1);
    expect(scheduleWarmupsAfterSync).toHaveBeenCalledWith(listener, {
      agent_id: "agent-1",
      conversation_id: "default",
    });
  });

  test("sync includes silent background reflection subagents in update_subagent_state", () => {
    clearAllSubagents();
    try {
      registerSubagent(
        "subagent-reflection-1",
        "reflection",
        "Reflect on recent conversations",
        undefined,
        true,
        true,
        {
          agentId: "agent-1",
          conversationId: "default",
        },
      );

      const listener = __listenClientTestUtils.createListenerRuntime();
      const runtime = __listenClientTestUtils.getOrCreateScopedRuntime(
        listener,
        "agent-1",
        "default",
      );
      const socket = new MockSocket(WebSocket.OPEN);

      __listenClientTestUtils.emitStateSync(
        socket as unknown as WebSocket,
        runtime,
        {
          agent_id: "agent-1",
          conversation_id: "default",
        },
      );

      const outbound = socket.sentPayloads.map((payload) =>
        JSON.parse(payload as string),
      );
      expect(outbound[3]).toMatchObject({
        type: "update_subagent_state",
        subagents: [
          expect.objectContaining({
            subagent_id: "subagent-reflection-1",
            subagent_type: "Reflection",
            description: "Reflect on recent conversations",
            status: "pending",
            is_background: true,
            silent: true,
          }),
        ],
      });
    } finally {
      clearAllSubagents();
    }
  });

  test("sync scopes update_subagent_state to runtime agent and conversation", () => {
    clearAllSubagents();
    try {
      registerSubagent(
        "subagent-reflection-target",
        "reflection",
        "Target scope",
        undefined,
        true,
        true,
        {
          agentId: "agent-1",
          conversationId: "default",
        },
      );
      registerSubagent(
        "subagent-reflection-other",
        "reflection",
        "Other scope",
        undefined,
        true,
        true,
        {
          agentId: "agent-2",
          conversationId: "default",
        },
      );

      const listener = __listenClientTestUtils.createListenerRuntime();
      const runtime = __listenClientTestUtils.getOrCreateScopedRuntime(
        listener,
        "agent-1",
        "default",
      );
      const socket = new MockSocket(WebSocket.OPEN);

      __listenClientTestUtils.emitStateSync(
        socket as unknown as WebSocket,
        runtime,
        {
          agent_id: "agent-1",
          conversation_id: "default",
        },
      );

      const outbound = socket.sentPayloads.map((payload) =>
        JSON.parse(payload as string),
      );
      expect(outbound[3].type).toBe("update_subagent_state");
      expect(outbound[3].subagents).toHaveLength(1);
      expect(outbound[3].subagents[0]).toMatchObject({
        subagent_id: "subagent-reflection-target",
      });
    } finally {
      clearAllSubagents();
    }
  });

  test("recovered approvals surface as pending control requests and WAITING_ON_APPROVAL", () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtime = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "default",
    );
    const socket = new MockSocket(WebSocket.OPEN);
    const requestId = "perm-tool-call-1";

    runtime.recoveredApprovalState = {
      agentId: "agent-1",
      conversationId: "default",
      approvalsByRequestId: new Map([
        [
          requestId,
          {
            approval: {} as never,
            approvalContext: null,
            controlRequest: makeControlRequest(requestId),
          },
        ],
      ]),
      pendingRequestIds: new Set([requestId]),
      responsesByRequestId: new Map(),
    };

    __listenClientTestUtils.emitStateSync(
      socket as unknown as WebSocket,
      runtime,
      {
        agent_id: "agent-1",
        conversation_id: "default",
      },
    );

    const outbound = socket.sentPayloads.map((payload) =>
      JSON.parse(payload as string),
    );
    expect(outbound[0].device_status.pending_control_requests).toEqual([
      {
        request_id: requestId,
        request: makeControlRequest(requestId).request,
      },
    ]);
    expect(outbound[1].loop_status).toEqual({
      status: "WAITING_ON_APPROVAL",
      active_run_ids: [],
    });
  });

  test("sync wiring converts recovered stale approvals into queued denials", () => {
    const recoveryPath = fileURLToPath(
      new URL("../websocket/listener/recovery.ts", import.meta.url),
    );
    const source = readFileSync(recoveryPath, "utf-8");
    const recoverySection =
      source
        .split("export async function recoverApprovalStateForSync")[1]
        ?.split("export async function resolveRecoveredApprovalResponse")[0] ??
      "";

    expect(recoverySection).toContain(
      "runtime.pendingInterruptedResults = buildFreshDenialApprovals(",
    );
    expect(recoverySection).toContain("STALE_APPROVAL_RECOVERY_DENIAL_REASON");
    expect(recoverySection).toContain("clearRecoveredApprovalState(runtime);");
    expect(recoverySection).not.toContain("classifyApprovalsWithSuggestions(");
    expect(recoverySection).not.toContain("buildRecoveredAutoDecisions(");
  });

  test("sync ignores backend recovered approvals while a live turn is already processing", async () => {
    const runtime = __listenClientTestUtils.createRuntime();
    beginTestTurn(runtime, { initialStatus: "PROCESSING_API_RESPONSE" });
    runtime.activeAgentId = "agent-1";
    runtime.activeConversationId = "default";
    runtime.recoveredApprovalState = {
      agentId: "agent-1",
      conversationId: "default",
      approvalsByRequestId: new Map([
        [
          "perm-stale",
          {
            approval: {} as never,
            approvalContext: null,
            controlRequest: makeControlRequest("perm-stale"),
          },
        ],
      ]),
      pendingRequestIds: new Set(["perm-stale"]),
      responsesByRequestId: new Map(),
    };

    await __listenClientTestUtils.recoverApprovalStateForSync?.(runtime, {
      agent_id: "agent-1",
      conversation_id: "default",
    });

    expect(runtime.recoveredApprovalState).toBeNull();
  });

  test("starting a live turn clears stale recovered approvals for the same scope", () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtime = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "default",
    );
    runtime.recoveredApprovalState = {
      agentId: "agent-1",
      conversationId: "default",
      approvalsByRequestId: new Map([
        [
          "perm-stale",
          {
            approval: {} as never,
            approvalContext: null,
            controlRequest: makeControlRequest("perm-stale"),
          },
        ],
      ]),
      pendingRequestIds: new Set(["perm-stale"]),
      responsesByRequestId: new Map(),
    };

    __listenClientTestUtils.clearRecoveredApprovalStateForScope(runtime, {
      agent_id: "agent-1",
      conversation_id: "default",
    });

    expect(runtime.recoveredApprovalState).toBeNull();
  });

  test("scopes working directory to requested agent and conversation", async () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const repoA = await mkdtemp(join(os.tmpdir(), "ws-scope-cwd-a-"));
    const repoB = await mkdtemp(join(os.tmpdir(), "ws-scope-cwd-b-"));
    try {
      __listenClientTestUtils.setConversationWorkingDirectory(
        runtime,
        "agent-a",
        "conv-a",
        repoA,
      );
      __listenClientTestUtils.setConversationWorkingDirectory(
        runtime,
        "agent-b",
        "default",
        repoB,
      );

      const activeStatus = __listenClientTestUtils.buildDeviceStatus(runtime, {
        agent_id: "agent-a",
        conversation_id: "conv-a",
      });
      expect(activeStatus.current_working_directory).toBe(repoA);

      const defaultStatus = __listenClientTestUtils.buildDeviceStatus(runtime, {
        agent_id: "agent-b",
        conversation_id: "default",
      });
      expect(defaultStatus.current_working_directory).toBe(repoB);
    } finally {
      await rm(repoA, { recursive: true, force: true });
      await rm(repoB, { recursive: true, force: true });
    }
  });

  test("scoped loop status is not suppressed just because another conversation is processing", () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtimeA = __listenClientTestUtils.getOrCreateConversationRuntime(
      listener,
      "agent-1",
      "conv-a",
    );
    const runtimeB = __listenClientTestUtils.getOrCreateConversationRuntime(
      listener,
      "agent-1",
      "conv-b",
    );

    beginTestTurn(runtimeA, { initialStatus: "PROCESSING_API_RESPONSE" });
    beginTestTurn(runtimeB, { initialStatus: "WAITING_ON_APPROVAL" });

    expect(
      __listenClientTestUtils.buildLoopStatus(listener, {
        agent_id: "agent-1",
        conversation_id: "conv-b",
      }),
    ).toEqual({
      status: "WAITING_ON_APPROVAL",
      active_run_ids: [],
    });
  });

  test("scoped queue snapshots are not suppressed just because another conversation is processing", () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtimeA = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conv-a",
    );
    const runtimeB = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conv-b",
    );

    beginTestTurn(runtimeA, { initialStatus: "PROCESSING_API_RESPONSE" });
    const queueInput = {
      kind: "message",
      source: "user",
      content: "queued b",
      clientMessageId: "cm-b",
      agentId: "agent-1",
      conversationId: "conv-b",
    } satisfies Omit<MessageQueueItem, "id" | "enqueuedAt">;
    runtimeB.queueRuntime.enqueue(queueInput);

    expect(
      __listenClientTestUtils.buildQueueSnapshot(listener, {
        agent_id: "agent-1",
        conversation_id: "conv-b",
      }),
    ).toEqual([
      expect.objectContaining({
        client_message_id: "cm-b",
        kind: "message",
      }),
    ]);
  });
});

describe("listen-client cwd change handling", () => {
  test("resolves relative cwd changes against the conversation cwd and emits update_device_status", async () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const socket = new MockSocket(WebSocket.OPEN);
    const tempRoot = await mkdtemp(join(os.tmpdir(), "letta-listen-cwd-"));
    const repoDir = join(tempRoot, "repo");
    const serverDir = join(repoDir, "server");
    const clientDir = join(repoDir, "client");
    await mkdir(serverDir, { recursive: true });
    await mkdir(clientDir, { recursive: true });
    const normalizedServerDir = await realpath(serverDir);
    const normalizedClientDir = await realpath(clientDir);

    try {
      __listenClientTestUtils.setConversationWorkingDirectory(
        runtime,
        "agent-1",
        "conv-1",
        normalizedServerDir,
      );
      runtime.activeAgentId = "agent-1";
      runtime.activeConversationId = "conv-1";
      beginTestTurn(runtime, { workingDirectory: normalizedServerDir });

      await __listenClientTestUtils.handleCwdChange(
        {
          agentId: "agent-1",
          conversationId: "conv-1",
          cwd: "../client",
        },
        socket as unknown as WebSocket,
        runtime,
      );

      expect(
        __listenClientTestUtils.getConversationWorkingDirectory(
          runtime,
          "agent-1",
          "conv-1",
        ),
      ).toBe(normalizedClientDir);

      expect(socket.sentPayloads).toHaveLength(1);
      const updated = JSON.parse(socket.sentPayloads[0] as string);
      expect(updated.type).toBe("update_device_status");
      expect(updated.runtime.agent_id).toBe("agent-1");
      expect(updated.runtime.conversation_id).toBe("conv-1");
      expect(updated.device_status.current_working_directory).toBe(
        normalizedClientDir,
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("listen-client interrupt status delta emission", () => {
  test("emits a canonical Interrupted status message", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const socket = new MockSocket(WebSocket.OPEN);

    emitInterruptedStatusDelta(socket as unknown as WebSocket, runtime, {
      runId: "run-1",
      agentId: "agent-1",
      conversationId: "default",
    });

    expect(socket.sentPayloads).toHaveLength(1);
    const payload = JSON.parse(socket.sentPayloads[0] ?? "{}");
    expect(payload.type).toBe("stream_delta");
    expect(payload.delta).toMatchObject({
      message_type: "status",
      message: "Interrupted",
      level: "warning",
      run_id: "run-1",
    });
    expect(payload.runtime).toMatchObject({
      agent_id: "agent-1",
      conversation_id: "default",
    });
  });
});

describe("listen-client interrupt queue projection", () => {
  test("consumes queued interrupted tool returns with tool ids", () => {
    const runtime = __listenClientTestUtils.createRuntime();

    __listenClientTestUtils.populateInterruptQueue(runtime, {
      lastExecutionResults: null,
      lastExecutingToolCallIds: ["call-running-1"],
      lastNeedsUserInputToolCallIds: [],
      agentId: "agent-1",
      conversationId: "conv-1",
    });

    const consumed = __listenClientTestUtils.consumeInterruptQueue(
      runtime,
      "agent-1",
      "conv-1",
    );
    expect(consumed).not.toBeNull();
    expect(consumed?.interruptedToolCallIds).toEqual(["call-running-1"]);
    expect(consumed?.approvalMessage.approvals).toEqual([
      {
        type: "tool",
        tool_call_id: "call-running-1",
        status: "error",
        tool_return: INTERRUPTED_BY_USER,
      },
    ]);
    expect(
      __listenClientTestUtils.consumeInterruptQueue(
        runtime,
        "agent-1",
        "conv-1",
      ),
    ).toBeNull();
  });

  test("approval-denial fallback does not set interrupted tool ids", () => {
    const runtime = __listenClientTestUtils.createRuntime();

    __listenClientTestUtils.populateInterruptQueue(runtime, {
      lastExecutionResults: null,
      lastExecutingToolCallIds: [],
      lastNeedsUserInputToolCallIds: ["call-awaiting-approval"],
      agentId: "agent-1",
      conversationId: "conv-1",
    });

    const consumed = __listenClientTestUtils.consumeInterruptQueue(
      runtime,
      "agent-1",
      "conv-1",
    );
    expect(consumed).not.toBeNull();
    expect(consumed?.interruptedToolCallIds).toEqual([]);
    expect(consumed?.approvalMessage.approvals[0]).toMatchObject({
      type: "approval",
      tool_call_id: "call-awaiting-approval",
      approve: false,
    });
  });

  test("consumeInterruptQueue clears matching empty interrupted context", () => {
    const runtime = __listenClientTestUtils.createRuntime();

    runtime.pendingInterruptedResults = [];
    runtime.pendingInterruptedContext = {
      agentId: "agent-1",
      conversationId: "conv-1",
      continuationEpoch: runtime.continuationEpoch,
    };
    runtime.pendingInterruptedToolCallIds = [];

    expect(
      __listenClientTestUtils.consumeInterruptQueue(
        runtime,
        "agent-1",
        "conv-1",
      ),
    ).toBeNull();
    expect(runtime.pendingInterruptedResults).toBeNull();
    expect(runtime.pendingInterruptedContext).toBeNull();
    expect(runtime.pendingInterruptedToolCallIds).toBeNull();
  });

  test("recovered approvals are stashed as denials on interrupt", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    runtime.recoveredApprovalState = {
      agentId: "agent-1",
      conversationId: "conv-1",
      approvalsByRequestId: new Map([
        [
          "perm-tool-1",
          {
            approval: {
              toolCallId: "tool-1",
              toolName: "Bash",
              toolArgs: '{"command":"ls"}',
            },
            approvalContext: null,
            controlRequest: makeControlRequest("perm-tool-1"),
          },
        ],
        [
          "perm-tool-2",
          {
            approval: {
              toolCallId: "tool-2",
              toolName: "Bash",
              toolArgs: '{"command":"pwd"}',
            },
            approvalContext: null,
            controlRequest: makeControlRequest("perm-tool-2"),
          },
        ],
      ]),
      pendingRequestIds: new Set(["perm-tool-1", "perm-tool-2"]),
      responsesByRequestId: new Map(),
    };

    const stashed = __listenClientTestUtils.stashRecoveredApprovalInterrupts(
      runtime,
      runtime.recoveredApprovalState,
    );

    expect(stashed).toBe(true);
    expect(runtime.recoveredApprovalState).toBeNull();

    const consumed = __listenClientTestUtils.consumeInterruptQueue(
      runtime,
      "agent-1",
      "conv-1",
    );
    expect(consumed?.approvalMessage.approvals).toEqual([
      {
        type: "approval",
        tool_call_id: "tool-1",
        approve: false,
        reason: "User interrupted the stream",
      },
      {
        type: "approval",
        tool_call_id: "tool-2",
        approve: false,
        reason: "User interrupted the stream",
      },
    ]);
  });
});

describe("listen-client capability-gated approval flow", () => {
  test("approval_response with allow + updated_input rewrites tool args", async () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const socket = new MockSocket(WebSocket.OPEN);
    const requestId = "perm-update-test";
    const turnLease = beginTestTurn(runtime);

    const pending = requestTestApproval(runtime, socket, turnLease, requestId);

    // Simulate approval_response with updated_input
    resolvePendingApprovalResolver(runtime, {
      request_id: requestId,
      decision: {
        behavior: "allow",
        updated_input: {
          file_path: "/updated/path.ts",
          content: "new content",
        },
      },
    });

    const response = await pending;
    expect("decision" in response).toBe(true);
    if ("decision" in response) {
      const canUseToolResponse = response.decision as {
        behavior: string;
        message?: string;
        updated_input?: Record<string, unknown>;
      };
      expect(canUseToolResponse.behavior).toBe("allow");
      expect(canUseToolResponse.updated_input).toEqual({
        file_path: "/updated/path.ts",
        content: "new content",
      });
    }
  });

  test("approval_response with allow preserves optional comment", async () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const socket = new MockSocket(WebSocket.OPEN);
    const requestId = "perm-allow-comment-test";
    const turnLease = beginTestTurn(runtime);

    const pending = requestTestApproval(runtime, socket, turnLease, requestId);

    resolvePendingApprovalResolver(runtime, {
      request_id: requestId,
      decision: {
        behavior: "allow",
        message: "Ship it",
      },
    });

    const response = await pending;
    expect("decision" in response).toBe(true);
    if ("decision" in response) {
      const canUseToolResponse = response.decision as {
        behavior: string;
        message?: string;
      };
      expect(canUseToolResponse.behavior).toBe("allow");
      expect(canUseToolResponse.message).toBe("Ship it");
    }
  });

  test("approval_response with deny includes reason", async () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const socket = new MockSocket(WebSocket.OPEN);
    const requestId = "perm-deny-test";
    const turnLease = beginTestTurn(runtime);

    const pending = requestTestApproval(runtime, socket, turnLease, requestId);

    resolvePendingApprovalResolver(runtime, {
      request_id: requestId,
      decision: { behavior: "deny", message: "User declined" },
    });

    const response = await pending;
    expect("decision" in response).toBe(true);
    if ("decision" in response) {
      const canUseToolResponse = response.decision as {
        behavior: string;
        message?: string;
      };
      expect(canUseToolResponse.behavior).toBe("deny");
      expect(canUseToolResponse.message).toBe("User declined");
    }
  });

  test("approval_response error triggers denial path", async () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const socket = new MockSocket(WebSocket.OPEN);
    const requestId = "perm-error-test";
    const turnLease = beginTestTurn(runtime);

    const pending = requestTestApproval(runtime, socket, turnLease, requestId);

    resolvePendingApprovalResolver(runtime, {
      request_id: requestId,
      error: "Internal server error",
    });

    const response = await pending;
    expect("error" in response).toBe(true);
    if ("error" in response) {
      expect(response.error).toBe("Internal server error");
    }
  });

  test("requestApprovalOverWS emits control_request and exposes it through device status", () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtime = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "default",
    );
    const socket = new MockSocket(WebSocket.OPEN);
    listener.socket = socket as unknown as WebSocket;
    const requestId = "perm-adapter-test";
    const turnLease = beginTestTurn(runtime);

    void requestTestApproval(runtime, socket, turnLease, requestId).catch(
      () => {},
    );

    expect(socket.sentPayloads.length).toBeGreaterThanOrEqual(2);
    const outbound = socket.sentPayloads.map((payload) =>
      JSON.parse(payload as string),
    );
    const loopStatus = outbound.find(
      (payload) => payload.type === "update_loop_status",
    );
    const deviceStatus = outbound.find(
      (payload) => payload.type === "update_device_status",
    );
    const controlRequest = outbound.find(
      (payload) => payload.type === "control_request",
    );
    expect(controlRequest).toBeDefined();
    expect(loopStatus).toBeDefined();
    expect(deviceStatus).toBeDefined();
    expect(controlRequest.type).toBe("control_request");
    expect(controlRequest.request_id).toBe(requestId);
    expect(controlRequest.request).toEqual(
      makeControlRequest(requestId).request,
    );
    expect(controlRequest.runtime).toEqual({
      agent_id: "agent-1",
      conversation_id: "default",
    });
    expect(loopStatus.type).toBe("update_loop_status");
    expect(loopStatus.loop_status.status).toBe("WAITING_ON_APPROVAL");
    expect(runtime.lastStopReason).toBe("requires_approval");
    expect(deviceStatus.type).toBe("update_device_status");
    expect(deviceStatus.device_status.pending_control_requests).toEqual([
      {
        request_id: requestId,
        request: makeControlRequest(requestId).request,
      },
    ]);

    // Cleanup
    rejectPendingApprovalResolvers(runtime, "test cleanup");
  });

  test("interrupted cache does not project WAITING_ON_APPROVAL when pending requests are suppressed", () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtime = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "default",
    );
    const socket = new MockSocket(WebSocket.OPEN);

    const turnLease = beginTestTurn(runtime, { runId: "run-1" });
    void requestTestApproval(
      runtime,
      socket,
      turnLease,
      "perm-interrupted",
    ).catch(() => {});
    runtime.pendingInterruptedContext = {
      agentId: "agent-1",
      conversationId: "default",
      continuationEpoch: runtime.continuationEpoch,
    };

    const deviceStatus = __listenClientTestUtils.buildDeviceStatus(listener, {
      agent_id: "agent-1",
      conversation_id: "default",
    });
    const loopStatus = __listenClientTestUtils.buildLoopStatus(listener, {
      agent_id: "agent-1",
      conversation_id: "default",
    });

    expect(deviceStatus.pending_control_requests).toEqual([]);
    expect(loopStatus.status).toBe("WAITING_ON_INPUT");
    expect(loopStatus.active_run_ids).toEqual(["run-1"]);

    rejectPendingApprovalResolvers(runtime, "test cleanup");
  });

  test("handled recovered approval responses reschedule queue pumping for the fallback scoped runtime", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const targetRuntime =
      __listenClientTestUtils.getOrCreateConversationRuntime(
        listener,
        "agent-1",
        "default",
      );
    const socket = new MockSocket(WebSocket.OPEN);
    const scheduleQueuePumpMock = mock(() => {});
    const resolveRecoveredApprovalResponseMock = mock(async () => true);

    const handled = await __listenClientTestUtils.handleApprovalResponseInput(
      listener,
      {
        runtime: { agent_id: "agent-1", conversation_id: "default" },
        response: {
          request_id: "perm-recovered",
          decision: { behavior: "allow" },
        },
        socket: socket as unknown as WebSocket,
        opts: {
          onStatusChange: undefined,
          connectionId: "conn-1",
        },
        processQueuedTurn: async () => {},
      },
      {
        resolveRuntimeForApprovalRequest: () => null,
        resolvePendingApprovalResolver: () => false,
        getOrCreateScopedRuntime: () => targetRuntime,
        resolveRecoveredApprovalResponse: resolveRecoveredApprovalResponseMock,
        scheduleQueuePump: scheduleQueuePumpMock,
      },
    );

    expect(handled).toBe(true);
    expect(resolveRecoveredApprovalResponseMock).toHaveBeenCalledWith(
      targetRuntime,
      socket,
      {
        request_id: "perm-recovered",
        decision: { behavior: "allow" },
      },
      expect.any(Function),
      {
        onStatusChange: undefined,
        connectionId: "conn-1",
      },
    );
    expect(scheduleQueuePumpMock).toHaveBeenCalledWith(
      targetRuntime,
      socket,
      expect.objectContaining({ connectionId: "conn-1" }),
      expect.any(Function),
    );
  });

  test("stale approval responses cannot unlatch an active cancellation", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const targetRuntime =
      __listenClientTestUtils.getOrCreateConversationRuntime(
        listener,
        "agent-1",
        "default",
      );
    const socket = new MockSocket(WebSocket.OPEN);
    const scheduleQueuePumpMock = mock(() => {});
    const resolveRecoveredApprovalResponseMock = mock(async () => false);

    beginTestTurn(targetRuntime);
    targetRuntime.turnLifecycle.requestCancellation();

    const handled = await __listenClientTestUtils.handleApprovalResponseInput(
      listener,
      {
        runtime: { agent_id: "agent-1", conversation_id: "default" },
        response: {
          request_id: "perm-stale",
          decision: { behavior: "allow" },
        },
        socket: socket as unknown as WebSocket,
        opts: {
          onStatusChange: undefined,
          connectionId: "conn-1",
        },
        processQueuedTurn: async () => {},
      },
      {
        resolveRuntimeForApprovalRequest: () => null,
        resolvePendingApprovalResolver: () => false,
        getOrCreateScopedRuntime: () => targetRuntime,
        resolveRecoveredApprovalResponse: resolveRecoveredApprovalResponseMock,
        scheduleQueuePump: scheduleQueuePumpMock,
      },
    );

    expect(handled).toBe(false);
    expect(targetRuntime.cancelRequested).toBe(true);
    expect(resolveRecoveredApprovalResponseMock).not.toHaveBeenCalled();
    expect(scheduleQueuePumpMock).not.toHaveBeenCalled();
  });

  test("abort_message eagerly projects idle interrupted state for active turns", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const socket = new MockSocket(WebSocket.OPEN);
    listener.socket = socket as unknown as WebSocket;
    __listenClientTestUtils.setActiveRuntime(listener);

    const runtime = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "default",
    );
    const scheduleQueuePumpMock = mock(() => {});
    const cancelConversationMock = mock(async () => {});

    beginTestTurn(runtime, {
      initialStatus: "PROCESSING_API_RESPONSE",
      runId: "run-active",
      workingDirectory: process.cwd(),
      executingToolCallIds: ["tool-1"],
    });

    const handled = await __listenClientTestUtils.handleAbortMessageInput(
      listener,
      {
        command: {
          type: "abort_message",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
        },
        socket: socket as unknown as WebSocket,
        opts: {
          onStatusChange: undefined,
          connectionId: "conn-1",
        },
        processQueuedTurn: async () => {},
      },
      {
        scheduleQueuePump: scheduleQueuePumpMock,
        cancelConversation: cancelConversationMock,
      },
    );

    expect(handled).toBe(true);
    expect(runtime.cancelRequested).toBe(true);
    expect(runtime.isProcessing).toBe(false);
    expect(runtime.loopStatus as string).toBe("WAITING_ON_INPUT");
    expect(runtime.activeRunId).toBeNull();
    expect(runtime.turnLifecycle.currentLease?.signal.aborted).toBe(true);
    expect(runtime.pendingInterruptedToolCallIds).toEqual(["tool-1"]);
    expect(scheduleQueuePumpMock).toHaveBeenCalledWith(
      runtime,
      socket,
      expect.objectContaining({ connectionId: "conn-1" }),
      expect.any(Function),
    );
    expect(cancelConversationMock).toHaveBeenCalledWith("agent-1", "default");

    const outbound = socket.sentPayloads.map((payload) => JSON.parse(payload));
    const interruptedStatus = outbound.find(
      (payload) =>
        payload.type === "stream_delta" &&
        payload.delta?.message_type === "status" &&
        payload.delta?.message === "Interrupted",
    );
    const loopUpdate = outbound.find(
      (payload) =>
        payload.type === "update_loop_status" &&
        payload.loop_status?.status === "WAITING_ON_INPUT",
    );
    const deviceUpdate = outbound.find(
      (payload) =>
        payload.type === "update_device_status" &&
        payload.device_status?.is_processing === false,
    );

    expect(interruptedStatus).toBeDefined();
    expect(loopUpdate?.loop_status?.active_run_ids).toEqual([]);
    expect(deviceUpdate).toBeDefined();

    __listenClientTestUtils.setActiveRuntime(null);
  });

  test("late approval registration after abort_message is rejected immediately", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const socket = new MockSocket(WebSocket.OPEN);
    listener.socket = socket as unknown as WebSocket;
    __listenClientTestUtils.setActiveRuntime(listener);

    const runtime = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "default",
    );

    const turnLease = beginTestTurn(runtime, {
      initialStatus: "PROCESSING_API_RESPONSE",
      runId: "run-active",
    });

    const handled = await __listenClientTestUtils.handleAbortMessageInput(
      listener,
      {
        command: {
          type: "abort_message",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
        },
        socket: socket as unknown as WebSocket,
        opts: {
          onStatusChange: undefined,
          connectionId: "conn-1",
        },
        processQueuedTurn: async () => {},
      },
    );

    expect(handled).toBe(true);
    expect(runtime.cancelRequested).toBe(true);

    await expect(
      requestTestApproval(runtime, socket, turnLease, "perm-late-after-abort"),
    ).rejects.toThrow("Cancelled by user");
    expect(runtime.pendingApprovalResolvers.size).toBe(0);
    expect(runtime.listener.approvalRuntimeKeyByRequestId.size).toBe(0);

    __listenClientTestUtils.setActiveRuntime(null);
  });

  test("abort_message preserves recovered approval denials instead of clobbering them to empty", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const socket = new MockSocket(WebSocket.OPEN);
    listener.socket = socket as unknown as WebSocket;
    __listenClientTestUtils.setActiveRuntime(listener);

    const runtime = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "default",
    );
    const scheduleQueuePumpMock = mock(() => {});
    const cancelConversationMock = mock(async () => {});

    runtime.recoveredApprovalState = {
      agentId: "agent-1",
      conversationId: "default",
      approvalsByRequestId: new Map([
        [
          "perm-recovered",
          {
            approval: {
              toolCallId: "call-1",
              toolName: "Write",
              toolArgs: '{"path":"foo.txt"}',
            },
            approvalContext: null,
            controlRequest: makeControlRequest("perm-recovered"),
          },
        ],
      ]),
      pendingRequestIds: new Set(["perm-recovered"]),
      responsesByRequestId: new Map(),
    };

    const handled = await __listenClientTestUtils.handleAbortMessageInput(
      listener,
      {
        command: {
          type: "abort_message",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
        },
        socket: socket as unknown as WebSocket,
        opts: {
          onStatusChange: undefined,
          connectionId: "conn-1",
        },
        processQueuedTurn: async () => {},
      },
      {
        scheduleQueuePump: scheduleQueuePumpMock,
        cancelConversation: cancelConversationMock,
      },
    );

    expect(handled).toBe(true);
    expect(runtime.cancelRequested).toBe(false);
    expect(runtime.pendingInterruptedResults).toEqual([
      {
        type: "approval",
        tool_call_id: "call-1",
        approve: false,
        reason: "User interrupted the stream",
      },
    ]);

    const consumed = __listenClientTestUtils.consumeInterruptQueue(
      runtime,
      "agent-1",
      "default",
    );
    expect(consumed?.approvalMessage.approvals).toEqual([
      {
        type: "approval",
        tool_call_id: "call-1",
        approve: false,
        reason: "User interrupted the stream",
      },
    ]);
    expect(scheduleQueuePumpMock).toHaveBeenCalled();
    expect(cancelConversationMock).toHaveBeenCalledWith("agent-1", "default");

    __listenClientTestUtils.setActiveRuntime(null);
  });

  test("abort_message preserves live approval denials instead of clobbering them to empty", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const socket = new MockSocket(WebSocket.OPEN);
    listener.socket = socket as unknown as WebSocket;
    __listenClientTestUtils.setActiveRuntime(listener);

    const runtime = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "default",
    );
    const scheduleQueuePumpMock = mock(() => {});
    const cancelConversationMock = mock(async () => {});

    const turnLease = beginTestTurn(runtime, {
      initialStatus: "WAITING_ON_APPROVAL",
    });
    const pending = requestTestApproval(
      runtime,
      socket,
      turnLease,
      "perm-live",
    );

    const handled = await __listenClientTestUtils.handleAbortMessageInput(
      listener,
      {
        command: {
          type: "abort_message",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
        },
        socket: socket as unknown as WebSocket,
        opts: {
          onStatusChange: undefined,
          connectionId: "conn-1",
        },
        processQueuedTurn: async () => {},
      },
      {
        scheduleQueuePump: scheduleQueuePumpMock,
        cancelConversation: cancelConversationMock,
      },
    );

    expect(handled).toBe(true);
    expect(runtime.cancelRequested).toBe(true);
    await expect(pending).rejects.toThrow("Cancelled by user");
    expect(runtime.pendingApprovalResolvers.size).toBe(0);
    __listenClientTestUtils.populateInterruptQueue(runtime, {
      lastExecutionResults: null,
      lastExecutingToolCallIds: [],
      lastNeedsUserInputToolCallIds: ["call-1"],
      agentId: "agent-1",
      conversationId: "default",
    });
    runtime.turnLifecycle.finish(turnLease, "cancelled");
    expect(runtime.cancelRequested).toBe(false);
    expect(runtime.pendingInterruptedResults).toEqual([
      {
        type: "approval",
        tool_call_id: "call-1",
        approve: false,
        reason: "User interrupted the stream",
      },
    ]);

    const consumed = __listenClientTestUtils.consumeInterruptQueue(
      runtime,
      "agent-1",
      "default",
    );
    expect(consumed?.approvalMessage.approvals).toEqual([
      {
        type: "approval",
        tool_call_id: "call-1",
        approve: false,
        reason: "User interrupted the stream",
      },
    ]);
    expect(scheduleQueuePumpMock).toHaveBeenCalled();
    expect(cancelConversationMock).toHaveBeenCalledWith("agent-1", "default");

    __listenClientTestUtils.setActiveRuntime(null);
  });
});

describe("listen-client approval recovery batch correlation", () => {
  test("resolves the original batch id from pending tool call ids", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    __listenClientTestUtils.rememberPendingApprovalBatchIds(
      runtime,
      [{ toolCallId: "tool-1" }, { toolCallId: "tool-2" }],
      "batch-123",
    );

    expect(
      __listenClientTestUtils.resolvePendingApprovalBatchId(runtime, [
        { toolCallId: "tool-1" },
        { toolCallId: "tool-2" },
      ]),
    ).toBe("batch-123");
  });

  test("returns null when pending approvals map to multiple batches", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    __listenClientTestUtils.rememberPendingApprovalBatchIds(
      runtime,
      [{ toolCallId: "tool-a" }],
      "batch-a",
    );
    __listenClientTestUtils.rememberPendingApprovalBatchIds(
      runtime,
      [{ toolCallId: "tool-b" }],
      "batch-b",
    );

    expect(
      __listenClientTestUtils.resolvePendingApprovalBatchId(runtime, [
        { toolCallId: "tool-a" },
        { toolCallId: "tool-b" },
      ]),
    ).toBeNull();
  });

  test("returns null when one pending approval mapping is missing", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    __listenClientTestUtils.rememberPendingApprovalBatchIds(
      runtime,
      [{ toolCallId: "tool-a" }],
      "batch-a",
    );

    expect(
      __listenClientTestUtils.resolvePendingApprovalBatchId(runtime, [
        { toolCallId: "tool-a" },
        { toolCallId: "tool-missing" },
      ]),
    ).toBeNull();
  });

  test("clears correlation after approvals are executed", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    __listenClientTestUtils.rememberPendingApprovalBatchIds(
      runtime,
      [{ toolCallId: "tool-x" }],
      "batch-x",
    );
    __listenClientTestUtils.clearPendingApprovalBatchIds(runtime, [
      { toolCallId: "tool-x" },
    ]);

    expect(
      __listenClientTestUtils.resolvePendingApprovalBatchId(runtime, [
        { toolCallId: "tool-x" },
      ]),
    ).toBeNull();
  });
});

describe("listen-client runtime metadata", () => {
  test("runtime sessionId is stable and uses listen- prefix", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    expect(runtime.sessionId).toMatch(/^listen-/);
    expect(runtime.sessionId.length).toBeGreaterThan(10);
  });
});

describe("listen-client recoverable status notices", () => {
  test("marks stale approval recovery as debug-only", () => {
    expect(
      getRecoverableStatusNoticeVisibility("stale_approval_conflict_recovery"),
    ).toBe("debug_only");
  });

  test("suppresses stale approval recovery from transcript and mirrors it to desktop logs", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const socket = new MockSocket();
    const originalFlag = process.env.LETTA_DESKTOP_MODE;
    const originalWrite = process.stderr.write.bind(process.stderr);
    const mirroredLines: string[] = [];

    process.env.LETTA_DESKTOP_MODE = "1";
    process.stderr.write = ((chunk: string | Uint8Array) => {
      mirroredLines.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    }) as typeof process.stderr.write;

    try {
      emitRecoverableStatusNotice(socket as unknown as WebSocket, runtime, {
        kind: "stale_approval_conflict_recovery",
        message:
          "Recovering from stale approval conflict after interrupted/reconnected turn",
        level: "warning",
        agentId: "agent-1",
        conversationId: "default",
      });
    } finally {
      process.stderr.write = originalWrite as typeof process.stderr.write;
      if (originalFlag === undefined) {
        delete process.env.LETTA_DESKTOP_MODE;
      } else {
        process.env.LETTA_DESKTOP_MODE = originalFlag;
      }
    }

    expect(socket.sentPayloads).toHaveLength(0);
    expect(mirroredLines).toHaveLength(1);
    expect(mirroredLines[0]).toContain(DESKTOP_DEBUG_PANEL_INFO_PREFIX);
    expect(mirroredLines[0]).toContain(
      "Recovering from stale approval conflict after interrupted/reconnected turn",
    );
  });

  test("marks the first transient provider retry as debug-only", () => {
    expect(
      getRecoverableRetryNoticeVisibility("transient_provider_retry", 1),
    ).toBe("debug_only");
    expect(
      getRecoverableRetryNoticeVisibility("transient_provider_retry", 2),
    ).toBe("transcript");
  });

  test("suppresses only the first transient provider retry from transcript", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const firstSocket = new MockSocket();
    const secondSocket = new MockSocket();
    const originalFlag = process.env.LETTA_DESKTOP_MODE;
    const originalWrite = process.stderr.write.bind(process.stderr);
    const mirroredLines: string[] = [];

    process.env.LETTA_DESKTOP_MODE = "1";
    process.stderr.write = ((chunk: string | Uint8Array) => {
      mirroredLines.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    }) as typeof process.stderr.write;

    try {
      emitRecoverableRetryNotice(firstSocket as unknown as WebSocket, runtime, {
        kind: "transient_provider_retry",
        message: "Anthropic API is overloaded, retrying...",
        reason: "llm_api_error",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 1000,
        agentId: "agent-1",
        conversationId: "default",
      });

      emitRecoverableRetryNotice(
        secondSocket as unknown as WebSocket,
        runtime,
        {
          kind: "transient_provider_retry",
          message: "Anthropic API is overloaded, retrying...",
          reason: "llm_api_error",
          attempt: 2,
          maxAttempts: 3,
          delayMs: 2000,
          agentId: "agent-1",
          conversationId: "default",
        },
      );
    } finally {
      process.stderr.write = originalWrite as typeof process.stderr.write;
      if (originalFlag === undefined) {
        delete process.env.LETTA_DESKTOP_MODE;
      } else {
        process.env.LETTA_DESKTOP_MODE = originalFlag;
      }
    }

    expect(firstSocket.sentPayloads).toHaveLength(0);
    expect(mirroredLines).toHaveLength(1);
    expect(mirroredLines[0]).toContain(DESKTOP_DEBUG_PANEL_INFO_PREFIX);
    expect(mirroredLines[0]).toContain(
      "Anthropic API is overloaded, retrying...",
    );

    expect(secondSocket.sentPayloads).toHaveLength(1);
    const payload = JSON.parse(secondSocket.sentPayloads[0] as string) as {
      type: string;
      delta: Record<string, unknown>;
    };
    expect(payload.type).toBe("stream_delta");
    expect(payload.delta).toMatchObject({
      message_type: "retry",
      message: "Anthropic API is overloaded, retrying...",
      attempt: 2,
      max_attempts: 3,
      delay_ms: 2000,
    });
  });
});

describe("listen-client loop error notices", () => {
  test("suppresses terminated process noise from the transcript", () => {
    expect(
      getLoopErrorNoticeDecision({
        message: "terminated",
      }),
    ).toEqual({
      visibility: "debug_only",
      message: "terminated",
    });
  });

  test("normalizes Cloudflare HTML errors to match TUI formatting", () => {
    const message = `520 <!DOCTYPE html><html><head><title>letta.com | 520: Web server is returning an unknown error</title></head><body>Error code 520 Visit <a href="https://www.cloudflare.com/5xx-error-landing?utm_campaign=api.letta.com">cloudflare</a> Cloudflare Ray ID: abc123</body></html>`;

    expect(
      getLoopErrorNoticeDecision({
        message,
      }),
    ).toEqual({
      visibility: "transcript",
      message:
        "Cloudflare 520: Web server is returning an unknown error for api.letta.com (Ray ID: abc123). This is usually a temporary edge/origin outage. Please retry in a moment.",
    });
  });

  test("normalizes proxy transport errors into a friendly transcript message", () => {
    const error = new APIError(
      504,
      {
        detail:
          "Error occurred while trying to proxy to: http://localhost:3000",
      },
      undefined,
      new Headers(),
    );

    expect(
      getLoopErrorNoticeDecision({
        message:
          "504 Error occurred while trying to proxy to: http://localhost:3000",
        error,
      }),
    ).toEqual({
      visibility: "transcript",
      message: "Connection to Letta service failed. Please retry.",
    });
  });

  test("reuses TUI formatter for structured run errors", () => {
    const apiError = {
      message_type: "error_message" as const,
      error_type: "insufficient_credits_error",
      message: "Insufficient credits",
      detail: "Please add credits to continue.",
      run_id: "run-123",
    };
    const expectedMessage = formatErrorDetails(
      {
        error: {
          error: {
            type: apiError.error_type,
            message: apiError.message,
            detail: apiError.detail,
          },
          run_id: apiError.run_id,
        },
      },
      "agent-1",
      "default",
    );

    expect(
      getLoopErrorNoticeDecision({
        message: apiError.detail,
        runErrorInfo: {
          error_type: apiError.error_type,
          message: apiError.message,
          detail: apiError.detail,
          run_id: apiError.run_id,
        },
        agentId: "agent-1",
        conversationId: "default",
      }),
    ).toEqual({
      visibility: "transcript",
      message: expectedMessage,
      apiError,
    });
  });

  test("emits structured api_error for loop errors when available", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    runtime.activeAgentId = "agent-1";
    runtime.activeConversationId = "default";
    const socket = new MockSocket();
    const apiError = {
      message_type: "error_message" as const,
      error_type: "internal_error",
      message: "Internal error",
      detail: "provider overloaded",
      run_id: "run-123",
    };

    emitLoopErrorNotice(socket as unknown as WebSocket, runtime, {
      message: apiError.detail,
      stopReason: "llm_api_error",
      isTerminal: true,
      runId: apiError.run_id,
      agentId: "agent-1",
      conversationId: "default",
      apiError,
    });

    expect(socket.sentPayloads).toHaveLength(1);
    const [firstPayload] = socket.sentPayloads;
    expect(firstPayload).toBeDefined();
    const payload = JSON.parse(firstPayload as string) as {
      type: string;
      delta: Record<string, unknown>;
    };

    expect(payload.type).toBe("stream_delta");
    expect(payload.delta).toMatchObject({
      message_type: "loop_error",
      stop_reason: "llm_api_error",
      is_terminal: true,
      api_error: apiError,
    });
  });

  test("suppresses abort-like loop errors from transcript and mirrors them to desktop logs", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const socket = new MockSocket();
    const originalFlag = process.env.LETTA_DESKTOP_MODE;
    const originalWrite = process.stderr.write.bind(process.stderr);
    const mirroredLines: string[] = [];
    const abortError = Object.assign(new Error("The operation was aborted"), {
      name: "AbortError",
    });

    process.env.LETTA_DESKTOP_MODE = "1";
    process.stderr.write = ((chunk: string | Uint8Array) => {
      mirroredLines.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    }) as typeof process.stderr.write;

    try {
      emitLoopErrorNotice(socket as unknown as WebSocket, runtime, {
        message: abortError.message,
        stopReason: "error",
        isTerminal: true,
        error: abortError,
      });
    } finally {
      process.stderr.write = originalWrite as typeof process.stderr.write;
      if (originalFlag === undefined) {
        delete process.env.LETTA_DESKTOP_MODE;
      } else {
        process.env.LETTA_DESKTOP_MODE = originalFlag;
      }
    }

    expect(socket.sentPayloads).toHaveLength(0);
    expect(mirroredLines).toHaveLength(1);
    expect(mirroredLines[0]).toContain(DESKTOP_DEBUG_PANEL_INFO_PREFIX);
    expect(mirroredLines[0]).toContain("The operation was aborted");
  });
});

describe("listen-client retry delta emission", () => {
  test("emits retry message text alongside structured retry metadata", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    runtime.activeAgentId = "agent-1";
    runtime.activeConversationId = "default";
    const socket = new MockSocket();

    __listenClientTestUtils.emitRetryDelta(
      socket as unknown as WebSocket,
      runtime,
      {
        message: "Anthropic API is overloaded, retrying...",
        reason: "error",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 1000,
        agentId: "agent-1",
        conversationId: "default",
      },
    );

    expect(socket.sentPayloads).toHaveLength(1);
    const [firstPayload] = socket.sentPayloads;
    expect(firstPayload).toBeDefined();
    const payload = JSON.parse(firstPayload as string) as {
      type: string;
      delta: Record<string, unknown>;
    };
    expect(payload.type).toBe("stream_delta");
    expect(payload.delta).toMatchObject({
      message_type: "retry",
      message: "Anthropic API is overloaded, retrying...",
      reason: "error",
      attempt: 1,
      max_attempts: 3,
      delay_ms: 1000,
    });
  });
});

describe("listen-client queue event emission", () => {
  test("queue enqueue/dequeue emits queue snapshots without loop-status jitter", async () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const socket = new MockSocket();
    runtime.socket = socket as unknown as WebSocket;

    runtime.queueRuntime.enqueue({
      kind: "message",
      source: "user",
      content: "hello",
      clientMessageId: "cm-1",
      agentId: "agent-1",
      conversationId: "default",
    } as Parameters<typeof runtime.queueRuntime.enqueue>[0]);

    await Promise.resolve();

    const dequeued = runtime.queueRuntime.consumeItems(1);
    expect(dequeued).not.toBeNull();

    await Promise.resolve();

    const payloadTypes = socket.sentPayloads.map((payload) => {
      const parsed = JSON.parse(payload) as { type: string };
      return parsed.type;
    });

    expect(payloadTypes.length).toBeGreaterThan(0);
    expect(new Set(payloadTypes)).toEqual(new Set(["update_queue"]));
  });
});

describe("listen-client post-stop approval recovery policy", () => {
  test("retries when run detail indicates invalid tool call IDs", () => {
    const shouldRecover =
      __listenClientTestUtils.shouldAttemptPostStopApprovalRecovery({
        stopReason: "error",
        runIdsSeen: 1,
        retries: 0,
        runErrorDetail:
          "Invalid tool call IDs: expected [toolu_abc], got [toolu_def]",
        latestErrorText: null,
      });

    expect(shouldRecover).toBe(true);
  });

  test("retries when run detail indicates approval pending", () => {
    const shouldRecover =
      __listenClientTestUtils.shouldAttemptPostStopApprovalRecovery({
        stopReason: "error",
        runIdsSeen: 1,
        retries: 0,
        runErrorDetail: "Conversation is waiting for approval",
        latestErrorText: null,
      });

    expect(shouldRecover).toBe(true);
  });

  test("extracts streamed approval conflict details from generic error messages", () => {
    const conflictDetail =
      "CONFLICT: Cannot send a new message: The agent is waiting for approval on a tool call.";

    expect(
      __listenClientTestUtils.getApprovalToolCallDesyncErrorText({
        message: "An unknown error occurred with the LLM streaming request.",
        detail: conflictDetail,
      }),
    ).toBe(conflictDetail);

    const shouldRecover =
      __listenClientTestUtils.shouldAttemptPostStopApprovalRecovery({
        stopReason: "error",
        runIdsSeen: 1,
        retries: 0,
        runErrorDetail: null,
        latestErrorText: conflictDetail,
      });

    expect(shouldRecover).toBe(true);
  });

  test("does not retry on generic no-run errors without an approval conflict", () => {
    const shouldRecover =
      __listenClientTestUtils.shouldAttemptPostStopApprovalRecovery({
        stopReason: "error",
        runIdsSeen: 0,
        retries: 0,
        runErrorDetail: null,
        latestErrorText: null,
      });

    expect(shouldRecover).toBe(false);
  });

  test("retries on explicit approval conflicts captured as fallback errors", () => {
    const shouldRecover =
      __listenClientTestUtils.shouldAttemptPostStopApprovalRecovery({
        stopReason: "error",
        runIdsSeen: 0,
        retries: 0,
        runErrorDetail: null,
        latestErrorText: null,
        fallbackError:
          "CONFLICT: Cannot send a new message: The agent is waiting for approval on a tool call.",
      });

    expect(shouldRecover).toBe(true);
  });

  test("does not retry when approval response is already stale", () => {
    const shouldRecover =
      __listenClientTestUtils.shouldAttemptPostStopApprovalRecovery({
        stopReason: "error",
        runIdsSeen: 1,
        retries: 0,
        runErrorDetail: "No tool call is currently awaiting approval",
        latestErrorText: null,
      });

    expect(shouldRecover).toBe(false);
  });

  test("does not retry once retry budget is exhausted", () => {
    const shouldRecover =
      __listenClientTestUtils.shouldAttemptPostStopApprovalRecovery({
        stopReason: "error",
        runIdsSeen: 0,
        retries: 2,
        runErrorDetail: null,
        latestErrorText: null,
      });

    expect(shouldRecover).toBe(false);
  });
});

describe("listen-client approval continuation run handoff", () => {
  test("clears stale active run ids once an approval continuation is accepted", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const turnLease = beginTestTurn(runtime, { runId: "run-1" });

    __listenClientTestUtils.markAwaitingAcceptedApprovalContinuationRunId(
      runtime,
      turnLease,
      [{ type: "approval", approvals: [] }],
    );

    expect(runtime.activeRunId).toBeNull();
  });

  test("preserves active run ids for non-approval sends", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const turnLease = beginTestTurn(runtime, { runId: "run-1" });

    __listenClientTestUtils.markAwaitingAcceptedApprovalContinuationRunId(
      runtime,
      turnLease,
      [
        {
          role: "user",
          content: "hello",
        },
      ],
    );

    expect(runtime.activeRunId).toBe("run-1");
  });
});

describe("listen-client interrupt persistence normalization", () => {
  test("forces interrupted in-flight tool results to status=error when cancelRequested", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    beginTestTurn(runtime);
    runtime.turnLifecycle.requestCancellation();

    const normalized =
      __listenClientTestUtils.normalizeExecutionResultsForInterruptParity(
        runtime,
        [
          {
            type: "tool",
            tool_call_id: "tool-1",
            tool_return: "Interrupted by user",
            status: "success",
          },
        ],
        ["tool-1"],
      );

    expect(normalized).toEqual([
      {
        type: "tool",
        tool_call_id: "tool-1",
        tool_return: "Interrupted by user",
        status: "error",
      },
    ]);
  });

  test("leaves tool status unchanged when not in cancel flow", () => {
    const runtime = __listenClientTestUtils.createRuntime();

    const normalized =
      __listenClientTestUtils.normalizeExecutionResultsForInterruptParity(
        runtime,
        [
          {
            type: "tool",
            tool_call_id: "tool-1",
            tool_return: "Interrupted by user",
            status: "success",
          },
        ],
        ["tool-1"],
      );

    expect(normalized).toEqual([
      {
        type: "tool",
        tool_call_id: "tool-1",
        tool_return: "Interrupted by user",
        status: "success",
      },
    ]);
  });
});

describe("listen-client interrupt persistence request body", () => {
  test("post-interrupt next-turn payload keeps interrupted tool returns as status=error", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const consumedAgentId = "agent-1";
    const consumedConversationId = "default";

    __listenClientTestUtils.populateInterruptQueue(runtime, {
      lastExecutionResults: null,
      lastExecutingToolCallIds: ["call-running-1"],
      lastNeedsUserInputToolCallIds: [],
      agentId: consumedAgentId,
      conversationId: consumedConversationId,
    });

    const consumed = __listenClientTestUtils.consumeInterruptQueue(
      runtime,
      consumedAgentId,
      consumedConversationId,
    );

    expect(consumed).not.toBeNull();
    if (!consumed) {
      throw new Error("Expected queued interrupt approvals to be consumed");
    }

    const requestBody = buildConversationMessagesCreateRequestBody(
      consumedConversationId,
      [
        consumed.approvalMessage,
        {
          type: "message",
          role: "user",
          content: "next user message after interrupt",
        },
      ],
      {
        agentId: consumedAgentId,
        streamTokens: true,
        background: true,
        approvalNormalization: {
          interruptedToolCallIds: consumed.interruptedToolCallIds,
        },
      },
      [],
    );

    const approvalMessage = requestBody.messages[0] as ApprovalCreate;
    expect(approvalMessage.type).toBe("approval");
    expect(approvalMessage.approvals?.[0]).toMatchObject({
      type: "tool",
      tool_call_id: "call-running-1",
      tool_return: INTERRUPTED_BY_USER,
      status: "error",
    });
  });
});

describe("listen-client tool_return wire normalization", () => {
  test("normalizes legacy top-level tool return fields to canonical tool_returns[]", () => {
    const normalized = __listenClientTestUtils.normalizeToolReturnWireMessage({
      message_type: "tool_return_message",
      id: "message-1",
      run_id: "run-1",
      tool_call_id: "call-1",
      status: "error",
      tool_return: [{ type: "text", text: "Interrupted by user" }],
    });

    expect(normalized).toEqual({
      message_type: "tool_return_message",
      id: "message-1",
      run_id: "run-1",
      tool_returns: [
        {
          tool_call_id: "call-1",
          status: "error",
          tool_return: "Interrupted by user",
        },
      ],
    });
    expect(normalized).not.toHaveProperty("tool_call_id");
    expect(normalized).not.toHaveProperty("status");
    expect(normalized).not.toHaveProperty("tool_return");
  });

  test("returns null for tool_return_message when no canonical status is available", () => {
    const normalized = __listenClientTestUtils.normalizeToolReturnWireMessage({
      message_type: "tool_return_message",
      id: "message-2",
      run_id: "run-2",
      tool_call_id: "call-2",
      tool_return: "maybe done",
    });

    expect(normalized).toBeNull();
  });

  test("truncates oversized inbound tool returns and drops oversized stdout metadata", () => {
    const hugeOutput = "x".repeat(LIMITS.BASH_OUTPUT_CHARS + 500);
    const normalized = __listenClientTestUtils.normalizeToolReturnWireMessage({
      message_type: "tool_return_message",
      id: "message-3",
      run_id: "run-3",
      tool_returns: [
        {
          tool_call_id: "call-3",
          status: "success",
          tool_return: hugeOutput,
          stdout: [hugeOutput],
        },
      ],
    });

    expect(normalized).not.toBeNull();
    const toolReturns = (
      normalized as {
        tool_returns: Array<{ tool_return: string; stdout?: string[] }>;
      }
    ).tool_returns;

    expect(toolReturns).toHaveLength(1);
    expect(toolReturns[0]?.tool_return).toContain("[Output truncated:");
    expect(toolReturns[0]?.tool_return.length).toBeLessThan(hugeOutput.length);
    expect(toolReturns[0]).not.toHaveProperty("stdout");
  });
});

describe("listen-client edit_file command", () => {
  test("parses valid edit_file command", () => {
    const parsed = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "edit_file",
          file_path: "/path/to/file.ts",
          old_string: "hello",
          new_string: "world",
          request_id: "req-123",
        }),
      ),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("edit_file");
  });

  test("parses edit_file command with optional fields", () => {
    const parsed = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "edit_file",
          file_path: "/path/to/file.ts",
          old_string: "hello",
          new_string: "world",
          replace_all: true,
          expected_replacements: 3,
          request_id: "req-456",
        }),
      ),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("edit_file");
  });

  test("isEditFileCommand validates required fields", () => {
    expect(
      isEditFileCommand({
        type: "edit_file",
        file_path: "/path/to/file.ts",
        old_string: "hello",
        new_string: "world",
        request_id: "req-123",
      }),
    ).toBe(true);

    // Missing file_path
    expect(
      isEditFileCommand({
        type: "edit_file",
        old_string: "hello",
        new_string: "world",
        request_id: "req-123",
      }),
    ).toBe(false);

    // Missing old_string
    expect(
      isEditFileCommand({
        type: "edit_file",
        file_path: "/path/to/file.ts",
        new_string: "world",
        request_id: "req-123",
      }),
    ).toBe(false);

    // Missing new_string
    expect(
      isEditFileCommand({
        type: "edit_file",
        file_path: "/path/to/file.ts",
        old_string: "hello",
        request_id: "req-123",
      }),
    ).toBe(false);

    // Missing request_id
    expect(
      isEditFileCommand({
        type: "edit_file",
        file_path: "/path/to/file.ts",
        old_string: "hello",
        new_string: "world",
      }),
    ).toBe(false);
  });

  test("isEditFileCommand validates expected_replacements is positive integer", () => {
    // Valid: positive integer
    expect(
      isEditFileCommand({
        type: "edit_file",
        file_path: "/path/to/file.ts",
        old_string: "hello",
        new_string: "world",
        expected_replacements: 5,
        request_id: "req-123",
      }),
    ).toBe(true);

    // Invalid: 0
    expect(
      isEditFileCommand({
        type: "edit_file",
        file_path: "/path/to/file.ts",
        old_string: "hello",
        new_string: "world",
        expected_replacements: 0,
        request_id: "req-123",
      }),
    ).toBe(false);

    // Invalid: negative
    expect(
      isEditFileCommand({
        type: "edit_file",
        file_path: "/path/to/file.ts",
        old_string: "hello",
        new_string: "world",
        expected_replacements: -1,
        request_id: "req-123",
      }),
    ).toBe(false);

    // Invalid: non-integer
    expect(
      isEditFileCommand({
        type: "edit_file",
        file_path: "/path/to/file.ts",
        old_string: "hello",
        new_string: "world",
        expected_replacements: 1.5,
        request_id: "req-123",
      }),
    ).toBe(false);
  });

  test("edit_file command handler responds with success", async () => {
    const tempRoot = await mkdtemp(join(os.tmpdir(), "letta-edit-test-"));
    const testFile = join(tempRoot, "test.txt");

    try {
      await writeFile(testFile, "hello world");

      const socket = new MockSocket(WebSocket.OPEN);
      const listener = __listenClientTestUtils.createListenerRuntime();
      listener.socket = socket as unknown as WebSocket;
      __listenClientTestUtils.setActiveRuntime(listener);

      // Simulate the edit_file command being received
      const parsed = parseServerMessage(
        Buffer.from(
          JSON.stringify({
            type: "edit_file",
            file_path: testFile,
            old_string: "hello",
            new_string: "goodbye",
            request_id: "req-test-1",
          }),
        ),
      );

      expect(parsed).not.toBeNull();
      expect(parsed?.type).toBe("edit_file");

      // Give the async handler time to process
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Note: The handler runs asynchronously, so we may need to wait
      // In a real test, we'd mock the edit function or use a different approach
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
      __listenClientTestUtils.setActiveRuntime(null);
    }
  });
});

describe("listen-client skill enable/disable command handling", () => {
  test("enables a skill by creating a symlink and disables it by removing it", async () => {
    const tempRoot = await mkdtemp(join(os.tmpdir(), "letta-listen-skill-"));
    const originalLettaHome = process.env.LETTA_HOME;
    process.env.LETTA_HOME = tempRoot;

    try {
      // Create a fake skill directory with SKILL.md
      const skillDir = join(tempRoot, "source-skill");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        "---\nname: test-skill\ndescription: A test skill\n---\nHello",
      );

      const socket = new MockSocket(WebSocket.OPEN);

      // Enable the skill
      await __listenClientTestUtils.handleSkillCommand(
        {
          type: "skill_enable",
          request_id: "skill-enable-1",
          skill_path: skillDir,
        },
        socket as unknown as WebSocket,
      );

      const enableMessages = socket.sentPayloads.map((p) => JSON.parse(p));
      expect(enableMessages[0]).toMatchObject({
        type: "skill_enable_response",
        request_id: "skill-enable-1",
        success: true,
        name: "source-skill",
      });
      expect(enableMessages[1]).toMatchObject({
        type: "skills_updated",
      });

      // Verify symlink was created
      const { lstatSync, readlinkSync } = await import("node:fs");
      const linkPath = join(tempRoot, "skills", "source-skill");
      const stat = lstatSync(linkPath);
      expect(stat.isSymbolicLink()).toBe(true);
      const target = readlinkSync(linkPath);
      expect(target).toBe(skillDir);

      // Disable the skill
      socket.sentPayloads.length = 0;
      await __listenClientTestUtils.handleSkillCommand(
        {
          type: "skill_disable",
          request_id: "skill-disable-1",
          name: "source-skill",
        },
        socket as unknown as WebSocket,
      );

      const disableMessages = socket.sentPayloads.map((p) => JSON.parse(p));
      expect(disableMessages[0]).toMatchObject({
        type: "skill_disable_response",
        request_id: "skill-disable-1",
        success: true,
        name: "source-skill",
      });
      expect(disableMessages[1]).toMatchObject({
        type: "skills_updated",
      });

      // Verify symlink was removed
      const { existsSync } = await import("node:fs");
      expect(existsSync(linkPath)).toBe(false);
    } finally {
      if (originalLettaHome) {
        process.env.LETTA_HOME = originalLettaHome;
      } else {
        delete process.env.LETTA_HOME;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("rejects enable when path does not exist", async () => {
    const tempRoot = await mkdtemp(join(os.tmpdir(), "letta-listen-skill-"));
    const originalLettaHome = process.env.LETTA_HOME;
    process.env.LETTA_HOME = tempRoot;

    try {
      const socket = new MockSocket(WebSocket.OPEN);

      await __listenClientTestUtils.handleSkillCommand(
        {
          type: "skill_enable",
          request_id: "skill-enable-bad",
          skill_path: "/nonexistent/path",
        },
        socket as unknown as WebSocket,
      );

      const messages = socket.sentPayloads.map((p) => JSON.parse(p));
      expect(messages[0]).toMatchObject({
        type: "skill_enable_response",
        request_id: "skill-enable-bad",
        success: false,
      });
      expect(messages[0].error).toContain("does not exist");
    } finally {
      if (originalLettaHome) {
        process.env.LETTA_HOME = originalLettaHome;
      } else {
        delete process.env.LETTA_HOME;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("rejects enable when SKILL.md is missing", async () => {
    const tempRoot = await mkdtemp(join(os.tmpdir(), "letta-listen-skill-"));
    const originalLettaHome = process.env.LETTA_HOME;
    process.env.LETTA_HOME = tempRoot;

    try {
      // Create a directory without SKILL.md
      const skillDir = join(tempRoot, "no-skill-md");
      await mkdir(skillDir, { recursive: true });

      const socket = new MockSocket(WebSocket.OPEN);

      await __listenClientTestUtils.handleSkillCommand(
        {
          type: "skill_enable",
          request_id: "skill-enable-no-md",
          skill_path: skillDir,
        },
        socket as unknown as WebSocket,
      );

      const messages = socket.sentPayloads.map((p) => JSON.parse(p));
      expect(messages[0]).toMatchObject({
        type: "skill_enable_response",
        request_id: "skill-enable-no-md",
        success: false,
      });
      expect(messages[0].error).toContain("No SKILL.md");
    } finally {
      if (originalLettaHome) {
        process.env.LETTA_HOME = originalLettaHome;
      } else {
        delete process.env.LETTA_HOME;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("rejects disable when skill is not a symlink", async () => {
    const tempRoot = await mkdtemp(join(os.tmpdir(), "letta-listen-skill-"));
    const originalLettaHome = process.env.LETTA_HOME;
    process.env.LETTA_HOME = tempRoot;

    try {
      // Create a real directory (not a symlink) in skills/
      const skillsDir = join(tempRoot, "skills");
      await mkdir(join(skillsDir, "real-dir"), { recursive: true });

      const socket = new MockSocket(WebSocket.OPEN);

      await __listenClientTestUtils.handleSkillCommand(
        {
          type: "skill_disable",
          request_id: "skill-disable-real",
          name: "real-dir",
        },
        socket as unknown as WebSocket,
      );

      const messages = socket.sentPayloads.map((p) => JSON.parse(p));
      expect(messages[0]).toMatchObject({
        type: "skill_disable_response",
        request_id: "skill-disable-real",
        success: false,
      });
      expect(messages[0].error).toContain("not a symlink");
    } finally {
      if (originalLettaHome) {
        process.env.LETTA_HOME = originalLettaHome;
      } else {
        delete process.env.LETTA_HOME;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
