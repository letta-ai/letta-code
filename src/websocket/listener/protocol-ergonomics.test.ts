import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type WebSocket from "ws";
import { __listenClientTestUtils } from "@/websocket/listen-client";
import { createListenerMessageHandler } from "@/websocket/listener/message-router";
import { parseServerMessage } from "@/websocket/listener/protocol-inbound";
import { resetRemoteSettingsCache } from "@/websocket/listener/remote-settings";
import type {
  IncomingMessage,
  ListenerRuntime,
  StartListenerOptions,
} from "@/websocket/listener/types";

function makeListenerOptions(): StartListenerOptions {
  return {
    connectionId: "conn-test",
    wsUrl: "wss://example.test/ws",
    deviceId: "device-test",
    connectionName: "listener-test",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
}

function makeHandler(
  runtime: ListenerRuntime,
  sent: unknown[],
  overrides: Partial<Parameters<typeof createListenerMessageHandler>[0]> = {},
) {
  return createListenerMessageHandler({
    runtime,
    socket: {} as WebSocket,
    opts: makeListenerOptions(),
    processQueuedTurn: async () => {},
    fileCommandSession: { handle: () => false },
    getParsedRuntimeScope: () => null,
    replaySyncStateForRuntime: async () => {},
    getOrCreateScopedRuntime: () => {
      throw new Error("unused in protocol ergonomics tests");
    },
    handleApprovalResponseInput: async () => false,
    handleChangeDeviceStateInput: async () => false,
    handleAbortMessageInput: async () => false,
    stampInboundUserMessageOtids: (incoming: IncomingMessage) => incoming,
    safeSocketSend: (_socket, payload) => {
      sent.push(payload);
      return true;
    },
    runDetachedListenerTask: () => {},
    trackListenerError: () => {},
    wireChannelIngress: async () => {},
    ...overrides,
  });
}

describe("listener protocol ergonomics", () => {
  afterEach(() => {
    __listenClientTestUtils.setActiveRuntime(null);
  });

  test("parses legacy environment messages as runtime-scoped input", () => {
    const parsed = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "message",
          agentId: "agent-1",
          conversationId: "conv-1",
          messages: [
            {
              type: "message",
              role: "user",
              content: "hello from cloud-api environment router",
              client_message_id: "cm-1",
            },
          ],
        }),
      ),
    );

    expect(parsed).toEqual({
      type: "input",
      runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
      payload: {
        kind: "create_message",
        messages: [
          {
            type: "message",
            role: "user",
            content: "hello from cloud-api environment router",
            client_message_id: "cm-1",
          },
        ],
        client_tool_allowlist: undefined,
        external_tool_scope_ids: undefined,
      },
    });
  });

  test("sync sends an ack response when request_id is provided", async () => {
    const runtime = __listenClientTestUtils.createListenerRuntime();
    const sent: unknown[] = [];
    const replaySyncStateForRuntime = mock(async () => {});
    __listenClientTestUtils.setActiveRuntime(runtime);

    await makeHandler(runtime, sent, { replaySyncStateForRuntime })(
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

    expect(replaySyncStateForRuntime).toHaveBeenCalledWith(
      runtime,
      expect.anything(),
      { agent_id: "agent-1", conversation_id: "default" },
      { recoverApprovals: false, forceDeviceStatus: true },
    );
    expect(sent).toContainEqual({
      type: "sync_response",
      request_id: "sync-1",
      runtime: { agent_id: "agent-1", conversation_id: "default" },
      success: true,
    });
  });

  test("sync request_id gets a failure response when the listener is inactive", async () => {
    const runtime = __listenClientTestUtils.createListenerRuntime();
    const sent: unknown[] = [];

    await makeHandler(
      runtime,
      sent,
    )(
      Buffer.from(
        JSON.stringify({
          type: "sync",
          request_id: "sync-closed",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
        }),
      ),
    );

    expect(sent).toContainEqual({
      type: "sync_response",
      request_id: "sync-closed",
      runtime: { agent_id: "agent-1", conversation_id: "default" },
      success: false,
      error: "Runtime is no longer active",
    });
  });

  test("abort_message sends an ack response when request_id is provided", async () => {
    const runtime = __listenClientTestUtils.createListenerRuntime();
    const sent: unknown[] = [];
    const handleAbortMessageInput = mock(async () => true);
    __listenClientTestUtils.setActiveRuntime(runtime);

    await makeHandler(runtime, sent, { handleAbortMessageInput })(
      Buffer.from(
        JSON.stringify({
          type: "abort_message",
          request_id: "abort-1",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
        }),
      ),
    );

    expect(handleAbortMessageInput).toHaveBeenCalled();
    expect(sent).toContainEqual({
      type: "abort_message_response",
      request_id: "abort-1",
      runtime: { agent_id: "agent-1", conversation_id: "default" },
      aborted: true,
      success: true,
    });
  });

  test("abort_message request_id reports idle no-op without timing out", async () => {
    const runtime = __listenClientTestUtils.createListenerRuntime();
    const sent: unknown[] = [];
    const handleAbortMessageInput = mock(async () => false);
    __listenClientTestUtils.setActiveRuntime(runtime);

    await makeHandler(runtime, sent, { handleAbortMessageInput })(
      Buffer.from(
        JSON.stringify({
          type: "abort_message",
          request_id: "abort-idle",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
        }),
      ),
    );

    expect(sent).toContainEqual({
      type: "abort_message_response",
      request_id: "abort-idle",
      runtime: { agent_id: "agent-1", conversation_id: "default" },
      aborted: false,
      success: true,
    });
  });

  test("get_cwd_map prunes stale active and non-active cwd entries before responding", async () => {
    const originalHome = process.env.HOME;
    const tempRoot = await mkdtemp(path.join(tmpdir(), "letta-cwd-map-"));
    const fakeHome = path.join(tempRoot, "home");
    const liveDir = path.join(tempRoot, "live");
    const deletedActiveDir = path.join(tempRoot, "deleted-active");
    const filePath = path.join(tempRoot, "not-a-directory");

    try {
      await mkdir(fakeHome);
      process.env.HOME = fakeHome;
      resetRemoteSettingsCache();
      const runtime = __listenClientTestUtils.createListenerRuntime();
      const sent: unknown[] = [];
      await mkdir(liveDir);
      await mkdir(deletedActiveDir);
      await writeFile(filePath, "not a directory");
      await rm(deletedActiveDir, { recursive: true, force: true });

      __listenClientTestUtils.getOrCreateScopedRuntime(
        runtime,
        "agent-1",
        "conv-active",
      );
      runtime.workingDirectoryByConversation.set(
        "conversation:conv-active",
        deletedActiveDir,
      );
      runtime.workingDirectoryByConversation.set(
        "conversation:conv-file",
        filePath,
      );
      runtime.workingDirectoryByConversation.set(
        "conversation:conv-live",
        liveDir,
      );

      await makeHandler(
        runtime,
        sent,
      )(
        Buffer.from(
          JSON.stringify({
            type: "get_cwd_map",
            request_id: "cwd-map-1",
          }),
        ),
      );

      expect(sent).toContainEqual({
        type: "get_cwd_map_response",
        request_id: "cwd-map-1",
        success: true,
        cwd_map: {
          "conversation:conv-live": liveDir,
        },
        boot_working_directory: runtime.bootWorkingDirectory,
      });
      expect(
        Object.fromEntries(runtime.workingDirectoryByConversation),
      ).toEqual({
        "conversation:conv-live": liveDir,
      });
      const persistedSettings = JSON.parse(
        await readFile(
          path.join(fakeHome, ".letta", "remote-settings.json"),
          "utf-8",
        ),
      );
      expect(persistedSettings.cwdMap).toEqual({
        "conversation:conv-live": liveDir,
      });
    } finally {
      resetRemoteSettingsCache();
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("unscoped device_status cwd_map prunes stale entries but preserves valid cwd entries", async () => {
    const originalHome = process.env.HOME;
    const tempRoot = await mkdtemp(
      path.join(tmpdir(), "letta-device-cwd-map-"),
    );
    const fakeHome = path.join(tempRoot, "home");
    const liveDir = path.join(tempRoot, "live");
    const deletedActiveDir = path.join(tempRoot, "deleted-active");
    const filePath = path.join(tempRoot, "not-a-directory");

    try {
      await mkdir(fakeHome);
      process.env.HOME = fakeHome;
      resetRemoteSettingsCache();
      const runtime = __listenClientTestUtils.createListenerRuntime();
      await mkdir(liveDir);
      await mkdir(deletedActiveDir);
      await writeFile(filePath, "not a directory");
      await rm(deletedActiveDir, { recursive: true, force: true });

      __listenClientTestUtils.getOrCreateScopedRuntime(
        runtime,
        "agent-1",
        "conv-active",
      );
      runtime.workingDirectoryByConversation.set(
        "conversation:conv-active",
        deletedActiveDir,
      );
      runtime.workingDirectoryByConversation.set(
        "conversation:conv-file",
        filePath,
      );
      runtime.workingDirectoryByConversation.set(
        "conversation:conv-live",
        liveDir,
      );

      const status = __listenClientTestUtils.buildDeviceStatus(runtime);

      expect(status.current_working_directory).toBe(
        runtime.bootWorkingDirectory,
      );
      expect(status.cwd_map).toEqual({
        "conversation:conv-live": liveDir,
      });
      expect(
        Object.fromEntries(runtime.workingDirectoryByConversation),
      ).toEqual({
        "conversation:conv-live": liveDir,
      });
    } finally {
      resetRemoteSettingsCache();
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
