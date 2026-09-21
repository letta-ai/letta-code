import { describe, expect, mock, test } from "bun:test";
import { QueueRuntime } from "@/queue/queue-runtime";
import type { ListenerRuntime, StartListenerOptions } from "./listener/types";
import {
  type LocalSessionOwnerDependencies,
  startLocalSessionOwner,
} from "./local-session-owner";

describe("local session owner", () => {
  test("closes admission before drain and waits for release acknowledgement", async () => {
    const sent: string[] = [];
    let capturedOptions: StartListenerOptions | undefined;
    const fakeRuntime = {
      transport: {
        isOpen: () => true,
        send: (payload: string) => sent.push(payload),
      },
      socket: null,
    } as unknown as ListenerRuntime;
    const stopListener = mock(() => {});
    const onError = mock(() => {});
    const dependencies: LocalSessionOwnerDependencies = {
      getDeviceId: () => "device-local",
      resolveRegistration: async () => ({
        serverUrl: "https://api.test",
        apiKey: "test",
        deviceId: "device-local",
        connectionName: "local",
      }),
      register: async () => ({
        connectionId: "conn-local",
        wsUrl: "wss://relay.test",
        supportsSplitStatusChannels: false,
        supportsPairedListenerGenerations: false,
        supportsLocalSessionOwnership: true,
      }),
      startListener: async (options) => {
        capturedOptions = options;
        options.onConnected(options.connectionId);
        return fakeRuntime;
      },
      stopListener,
    };
    const queue = new QueueRuntime({ maxItems: Infinity });
    const owner = await startLocalSessionOwner(
      {
        agentId: "agent-local",
        conversationId: "conv-local",
        queueRuntime: queue,
        surfaceName: "headless",
        onQueueChanged: () => {},
        onAbort: () => true,
        isProcessing: () => false,
        onError,
        releaseRetryMs: 1,
        waitForAcceptedInputs: async () => {
          expect(queue.length).toBe(0);
        },
      },
      dependencies,
    );
    if (!capturedOptions?.localSessionOwner) {
      throw new Error("session owner options were not attached");
    }
    const session = capturedOptions.localSessionOwner;
    const claimFrame = JSON.parse(sent[0] ?? "{}") as {
      request_id?: string;
    };
    expect(claimFrame).toMatchObject({
      type: "claim_session_owner",
      runtime: { agent_id: "agent-local", conversation_id: "conv-local" },
    });
    capturedOptions.onWsEvent?.("recv", "lifecycle", {
      type: "_ws_unparseable",
      raw: JSON.stringify({
        type: "session_owner_claimed",
        request_id: claimFrame.request_id,
        claimed: true,
      }),
    });
    expect(await owner.ready()).toBe(true);

    expect(
      session.acceptInput({
        type: "message",
        agentId: "agent-local",
        conversationId: "conv-local",
        actingUserId: "user-sender",
        messages: [
          {
            role: "user",
            content: "accepted before boundary",
            client_message_id: "cm-1",
          },
        ],
      }),
    ).toBe(true);
    owner.stopAdmission();
    expect(
      session.acceptInput({
        type: "message",
        agentId: "agent-local",
        conversationId: "conv-local",
        messages: [
          {
            role: "user",
            content: "late after boundary",
            client_message_id: "cm-2",
          },
        ],
      }),
    ).toBe(false);

    const batch = queue.consumeItems(queue.readyLength);
    expect(batch?.items).toMatchObject([
      { clientMessageId: "cm-1", actingUserId: "user-sender" },
    ]);

    const rejectedRelease = owner.release();
    while (sent.length < 2) await Bun.sleep(1);
    const rejectedFrame = JSON.parse(sent[1] ?? "{}") as {
      request_id?: string;
    };
    capturedOptions.onWsEvent?.("recv", "lifecycle", {
      type: "_ws_unparseable",
      raw: JSON.stringify({
        type: "session_owner_released",
        request_id: rejectedFrame.request_id,
        released: false,
      }),
    });
    expect(stopListener).not.toHaveBeenCalled();
    while (sent.length < 3) await Bun.sleep(1);
    expect(onError).toHaveBeenCalledTimes(1);

    const frame = JSON.parse(sent[2] ?? "{}") as { request_id?: string };
    expect(frame).toMatchObject({
      type: "release_session_owner",
      runtime: { agent_id: "agent-local", conversation_id: "conv-local" },
    });
    capturedOptions.onWsEvent?.("recv", "lifecycle", {
      type: "_ws_unparseable",
      raw: JSON.stringify({
        type: "session_owner_released",
        request_id: frame.request_id,
        released: true,
      }),
    });
    expect(await rejectedRelease).toBe(true);
    expect(stopListener).toHaveBeenCalledTimes(1);
  });

  test("does not claim ownership when Cloud lacks protocol support", async () => {
    const startListener = mock(async () => ({}) as ListenerRuntime);
    const owner = await startLocalSessionOwner(
      {
        agentId: "agent-local",
        conversationId: "conv-local",
        queueRuntime: new QueueRuntime(),
        surfaceName: "headless",
        onQueueChanged: () => {},
        onAbort: () => true,
        isProcessing: () => false,
      },
      {
        getDeviceId: () => "device-local",
        resolveRegistration: async () => ({
          serverUrl: "https://api.test",
          apiKey: "test",
          deviceId: "device-local",
          connectionName: "local",
        }),
        register: async () => ({
          connectionId: "conn-local",
          wsUrl: "wss://relay.test",
          supportsSplitStatusChannels: true,
          supportsPairedListenerGenerations: true,
          supportsLocalSessionOwnership: false,
        }),
        startListener,
        stopListener: () => {},
      },
    );

    expect(startListener).not.toHaveBeenCalled();
    expect(await owner.ready()).toBe(false);
    expect(await owner.release()).toBe(true);
  });

  test("advertised ownership stays unready until a positive scoped claim", async () => {
    const sent: string[] = [];
    let capturedOptions: StartListenerOptions | undefined;
    const owner = await startLocalSessionOwner(
      {
        agentId: "agent-local",
        conversationId: "conv-local",
        queueRuntime: new QueueRuntime(),
        surfaceName: "headless",
        onQueueChanged: () => {},
        onAbort: () => true,
        isProcessing: () => false,
        releaseRetryMs: 1,
      },
      {
        getDeviceId: () => "device-local",
        resolveRegistration: async () => ({
          serverUrl: "https://api.test",
          apiKey: "test",
          deviceId: "device-local",
          connectionName: "local",
        }),
        register: async () => ({
          connectionId: "conn-local",
          wsUrl: "wss://relay.test",
          supportsSplitStatusChannels: false,
          supportsPairedListenerGenerations: false,
          supportsLocalSessionOwnership: true,
        }),
        startListener: async (options) => {
          capturedOptions = options;
          options.onConnected(options.connectionId);
          return {
            transport: {
              isOpen: () => true,
              send: (payload: string) => sent.push(payload),
            },
          } as unknown as ListenerRuntime;
        },
        stopListener: () => {},
      },
    );
    const first = JSON.parse(sent[0] ?? "{}") as { request_id?: string };
    capturedOptions?.onWsEvent?.("recv", "lifecycle", {
      type: "_ws_unparseable",
      raw: JSON.stringify({
        type: "session_owner_claimed",
        request_id: first.request_id,
        claimed: false,
      }),
    });
    expect(
      await Promise.race([
        owner.ready().then(() => "ready" as const),
        Bun.sleep(5).then(() => "pending" as const),
      ]),
    ).toBe("pending");

    while (sent.length < 2) await Bun.sleep(1);
    const retry = JSON.parse(sent[1] ?? "{}") as { request_id?: string };
    capturedOptions?.onWsEvent?.("recv", "lifecycle", {
      type: "_ws_unparseable",
      raw: JSON.stringify({
        type: "session_owner_claimed",
        request_id: retry.request_id,
        claimed: true,
      }),
    });
    expect(await owner.ready()).toBe(true);
  });
});
