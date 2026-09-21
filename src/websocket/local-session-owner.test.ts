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
      }),
      startListener: async (options) => {
        capturedOptions = options;
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

    expect(
      session.acceptInput({
        type: "message",
        agentId: "agent-local",
        conversationId: "conv-local",
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
    expect(batch?.items.map((item) => item.clientMessageId)).toEqual(["cm-1"]);

    const releasing = owner.release();
    await Promise.resolve();
    const frame = JSON.parse(sent[0] ?? "{}") as { request_id?: string };
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
    await releasing;
    expect(stopListener).toHaveBeenCalledTimes(1);
  });
});
