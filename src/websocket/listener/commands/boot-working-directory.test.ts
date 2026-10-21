import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import {
  markListenerConnectionInitialized,
  openListenerConnection,
  subscribeListenerConnection,
} from "@/websocket/listener/connection";
import { getConversationWorkingDirectory } from "@/websocket/listener/cwd";
import { createRuntime } from "@/websocket/listener/lifecycle";
import { parseServerMessage } from "@/websocket/listener/protocol-inbound";
import { buildDeviceStatus } from "@/websocket/listener/protocol-outbound";
import { createConversationRuntime } from "@/websocket/listener/runtime";
import type { ListenerRuntime } from "@/websocket/listener/types";
import { handleSetBootWorkingDirectoryCommand } from "./boot-working-directory";
import type { SafeSocketSend } from "./types";

const tempRoots: string[] = [];

class MockSocket {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  sentPayloads: string[] = [];

  send(data: string): void {
    this.sentPayloads.push(data);
  }
}

async function makeDirectory(name: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `letta-boot-cwd-${name}-`));
  tempRoots.push(root);
  return realpath(root);
}

function createIsolatedRuntime(): ListenerRuntime {
  const runtime = createRuntime();
  runtime.workingDirectoryByConversation.clear();
  runtime.workingDirectoryRevision = 0;
  return runtime;
}

function makeSender(): { sent: unknown[]; safeSocketSend: SafeSocketSend } {
  const sent: unknown[] = [];
  const safeSocketSend = mock((_socket, payload) => {
    sent.push(payload);
    return true;
  }) as SafeSocketSend;
  return { sent, safeSocketSend };
}

async function sendCommand(params: {
  runtime: ListenerRuntime;
  cwd: string;
  requestId: string;
  safeSocketSend: SafeSocketSend;
  socket?: WebSocket;
}): Promise<void> {
  await handleSetBootWorkingDirectoryCommand(
    {
      type: "set_boot_working_directory",
      request_id: params.requestId,
      cwd: params.cwd,
    },
    {
      socket: params.socket ?? ({} as WebSocket),
      runtime: params.runtime,
      safeSocketSend: params.safeSocketSend,
    },
  );
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("set_boot_working_directory", () => {
  test("parses an acknowledged listener-wide command", () => {
    expect(
      parseServerMessage(
        Buffer.from(
          JSON.stringify({
            type: "set_boot_working_directory",
            request_id: "cwd-1",
            cwd: "/tmp/project",
          }),
        ),
      ),
    ).toEqual({
      type: "set_boot_working_directory",
      request_id: "cwd-1",
      cwd: "/tmp/project",
    });

    expect(
      parseServerMessage(
        Buffer.from(
          JSON.stringify({
            type: "set_boot_working_directory",
            cwd: "/tmp/project",
          }),
        ),
      ),
    ).toBeNull();
  });

  test("moves future unmapped turns while preserving mapped and active work", async () => {
    const bootA = await makeDirectory("a");
    const bootB = await makeDirectory("b");
    const explicitC = await makeDirectory("c");
    const runtime = createIsolatedRuntime();
    runtime.bootWorkingDirectory = bootA;
    runtime.workingDirectoryRevision = 7;

    const active = createConversationRuntime(runtime, "agent-1", "conv-1");
    const explicit = createConversationRuntime(runtime, "agent-1", "conv-2");
    active.reminderState.hasSentSessionContext = true;
    explicit.reminderState.hasSentSessionContext = true;
    runtime.workingDirectoryByConversation.set(
      "conversation:conv-2",
      explicitC,
    );
    const activeLease = active.turnLifecycle.begin({
      origin: "message",
      workingDirectory: bootA,
    });
    const pendingApproval = {} as never;
    active.pendingApprovalResolvers.set("approval-1", pendingApproval);
    const serviceCommandHandler = mock(
      async () => ({ success: true }) as never,
    ) as NonNullable<ListenerRuntime["serviceCommandHandler"]>;
    runtime.processServicesStarted = true;
    runtime.serviceCommandHandler = serviceCommandHandler;
    runtime.serviceCommandTypes.add("channels_list");
    const serviceCommandTypesBefore = runtime.serviceCommandTypes;
    const cwdMapBefore = Object.fromEntries(
      runtime.workingDirectoryByConversation,
    );
    const processCwdBefore = process.cwd();
    const userCwdBefore = process.env.USER_CWD;
    const pidBefore = process.pid;
    const { sent, safeSocketSend } = makeSender();

    await sendCommand({
      runtime,
      cwd: bootB,
      requestId: "cwd-2",
      safeSocketSend,
    });

    expect(runtime.bootWorkingDirectory).toBe(bootB);
    expect(getConversationWorkingDirectory(runtime, "agent-1", "conv-1")).toBe(
      bootB,
    );
    expect(getConversationWorkingDirectory(runtime, "agent-1", "conv-2")).toBe(
      explicitC,
    );
    expect(Object.fromEntries(runtime.workingDirectoryByConversation)).toEqual(
      cwdMapBefore,
    );
    expect(active.activeWorkingDirectory).toBe(bootA);
    expect(active.turnLifecycle.isCurrent(activeLease)).toBe(true);
    expect(active.pendingApprovalResolvers.get("approval-1")).toBe(
      pendingApproval,
    );
    expect(runtime.processServicesStarted).toBe(true);
    expect(runtime.serviceCommandHandler).toBe(serviceCommandHandler);
    expect(runtime.serviceCommandTypes).toBe(serviceCommandTypesBefore);
    expect(runtime.serviceCommandTypes.has("channels_list")).toBe(true);
    expect(buildDeviceStatus(runtime).boot_working_directory).toBe(bootB);
    expect(buildDeviceStatus(active).current_working_directory).toBe(bootA);
    expect(buildDeviceStatus(explicit).current_working_directory).toBe(
      explicitC,
    );
    expect(active.reminderState.hasSentSessionContext).toBe(false);
    expect(explicit.reminderState.hasSentSessionContext).toBe(true);
    expect(active.reminderState.pendingSessionContextReason).toBe(
      "cwd_changed",
    );
    expect(process.cwd()).toBe(processCwdBefore);
    expect(process.env.USER_CWD).toBe(userCwdBefore);
    expect(process.pid).toBe(pidBefore);
    expect(runtime.workingDirectoryRevision).toBe(8);
    expect(sent).toContainEqual({
      type: "set_boot_working_directory_response",
      request_id: "cwd-2",
      success: true,
      boot_working_directory: bootB,
      cwd_revision: 8,
    });
  });

  test("resolves relative directories against the current boot CWD", async () => {
    const root = await makeDirectory("relative");
    const bootA = path.join(root, "a");
    const bootB = path.join(root, "b");
    await Promise.all([mkdir(bootA), mkdir(bootB)]);
    const runtime = createIsolatedRuntime();
    runtime.bootWorkingDirectory = bootA;
    runtime.workingDirectoryRevision = 2;
    const { sent, safeSocketSend } = makeSender();

    await sendCommand({
      runtime,
      cwd: "../b",
      requestId: "cwd-relative",
      safeSocketSend,
    });

    expect(runtime.bootWorkingDirectory).toBe(bootB);
    expect(sent).toContainEqual({
      type: "set_boot_working_directory_response",
      request_id: "cwd-relative",
      success: true,
      boot_working_directory: bootB,
      cwd_revision: 3,
    });
  });

  test("sends each active scope an updated status", async () => {
    const bootA = await makeDirectory("status-a");
    const bootB = await makeDirectory("status-b");
    const runtime = createIsolatedRuntime();
    runtime.bootWorkingDirectory = bootA;
    createConversationRuntime(runtime, "agent-1", "conv-1");
    createConversationRuntime(runtime, "agent-2", "conv-2");
    const socket1 = new MockSocket();
    const socket2 = new MockSocket();

    for (const [connectionId, socket, scope] of [
      ["conn-1", socket1, { agent_id: "agent-1", conversation_id: "conv-1" }],
      ["conn-2", socket2, { agent_id: "agent-2", conversation_id: "conv-2" }],
    ] as const) {
      openListenerConnection({
        runtime,
        connectionId,
        writer: socket as never,
        options: {
          connectionId,
          wsUrl: "ws://test",
          deviceId: "test",
          connectionName: connectionId,
          onConnected: () => {},
          onDisconnected: () => {},
          onError: () => {},
        },
      });
      markListenerConnectionInitialized(runtime, connectionId);
      subscribeListenerConnection(runtime, connectionId, scope);
    }

    const { safeSocketSend } = makeSender();
    await sendCommand({
      runtime,
      cwd: bootB,
      requestId: "cwd-status",
      safeSocketSend,
      socket: socket1 as never,
    });

    for (const [socket, scope] of [
      [socket1, { agent_id: "agent-1", conversation_id: "conv-1" }],
      [socket2, { agent_id: "agent-2", conversation_id: "conv-2" }],
    ] as const) {
      expect(socket.sentPayloads).toHaveLength(1);
      expect(JSON.parse(socket.sentPayloads[0] ?? "{}")).toMatchObject({
        type: "update_device_status",
        runtime: scope,
        device_status: {
          current_working_directory: bootB,
          cwd_revision: 1,
        },
      });
    }
  });

  test("rejects invalid directories without changing listener state", async () => {
    const bootA = await makeDirectory("original");
    const fileRoot = await makeDirectory("file");
    const filePath = path.join(fileRoot, "not-a-directory");
    const missingPath = path.join(fileRoot, "missing");
    await writeFile(filePath, "x");
    const runtime = createIsolatedRuntime();
    runtime.bootWorkingDirectory = bootA;
    runtime.workingDirectoryRevision = 3;
    const { sent, safeSocketSend } = makeSender();

    await sendCommand({
      runtime,
      cwd: " ",
      requestId: "cwd-empty",
      safeSocketSend,
    });
    await sendCommand({
      runtime,
      cwd: missingPath,
      requestId: "cwd-missing",
      safeSocketSend,
    });
    await sendCommand({
      runtime,
      cwd: filePath,
      requestId: "cwd-file",
      safeSocketSend,
    });

    expect(runtime.bootWorkingDirectory).toBe(bootA);
    expect(runtime.workingDirectoryRevision).toBe(3);
    expect(sent).toContainEqual({
      type: "set_boot_working_directory_response",
      request_id: "cwd-empty",
      success: false,
      boot_working_directory: bootA,
      cwd_revision: 3,
      error: "Working directory cannot be empty",
    });
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "set_boot_working_directory_response",
        request_id: "cwd-missing",
        success: false,
        boot_working_directory: bootA,
        cwd_revision: 3,
      }),
    );
    expect(sent).toContainEqual({
      type: "set_boot_working_directory_response",
      request_id: "cwd-file",
      success: false,
      boot_working_directory: bootA,
      cwd_revision: 3,
      error: `Not a directory: ${filePath}`,
    });
  });

  test("does not advance the revision for a normalized no-op", async () => {
    const root = await makeDirectory("no-op");
    const boot = path.join(root, "boot");
    await mkdir(boot);
    const runtime = createIsolatedRuntime();
    runtime.bootWorkingDirectory = boot;
    runtime.workingDirectoryRevision = 4;
    const { sent, safeSocketSend } = makeSender();

    await sendCommand({
      runtime,
      cwd: path.join(root, ".", "boot"),
      requestId: "cwd-no-op",
      safeSocketSend,
    });

    expect(runtime.workingDirectoryRevision).toBe(4);
    expect(sent).toContainEqual({
      type: "set_boot_working_directory_response",
      request_id: "cwd-no-op",
      success: true,
      boot_working_directory: boot,
      cwd_revision: 4,
    });
  });
});
