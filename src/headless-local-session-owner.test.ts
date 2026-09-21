import { describe, expect, mock, test } from "bun:test";
import type { LocalSessionOwnerHandle } from "@/websocket/local-session-owner";
import {
  startHeadlessLocalSession,
  takeAcceptedHeadlessInputs,
} from "./headless-local-session-owner";

describe("headless local session ownership", () => {
  test("initial turn waits for positive scoped owner readiness", async () => {
    let resolveOwner!: (owner: LocalSessionOwnerHandle) => void;
    const pendingOwner = new Promise<LocalSessionOwnerHandle>((resolve) => {
      resolveOwner = resolve;
    });
    const release = mock(async () => true);
    const ready = mock(async () => true);
    const session = startHeadlessLocalSession(
      {
        enabled: true,
        agentId: "agent-local",
        conversationId: "conv-local",
        sigintSignal: new AbortController().signal,
      },
      async () => pendingOwner,
    );

    expect(session.owner).toBeNull();
    const started = session.start();
    expect(session.owner).toBeNull();
    resolveOwner({
      ready,
      forceStop() {},
      stopAdmission() {},
      resumeAdmission() {},
      release,
    });
    expect(await started).toBe(true);
    expect(await session.start()).toBe(true);
    expect(ready).toHaveBeenCalledTimes(2);
    expect(session.owner).not.toBeNull();
    await session.release();
    expect(release).toHaveBeenCalledTimes(1);
  });

  test("accepted follow-ups retain sender attribution", () => {
    const session = startHeadlessLocalSession({
      enabled: false,
      agentId: "agent-local",
      conversationId: "conv-local",
      sigintSignal: new AbortController().signal,
    });
    session.queue.enqueue({
      kind: "message",
      source: "user",
      content: "follow up",
      actingUserId: "user-sender",
    } as Parameters<typeof session.queue.enqueue>[0]);

    expect(takeAcceptedHeadlessInputs(session)).toMatchObject({
      actingUserId: "user-sender",
      input: [{ role: "user", content: "follow up" }],
    });
  });

  test("shutdown can cancel an owner while initial readiness is pending", async () => {
    let rejectReady!: (error: Error) => void;
    const readyPromise = new Promise<boolean>((_resolve, reject) => {
      rejectReady = reject;
    });
    const release = mock(async () => {
      rejectReady(new Error("claim cancelled"));
      return true;
    });
    const forceStop = mock(() => rejectReady(new Error("claim cancelled")));
    const sigint = new AbortController();
    const session = startHeadlessLocalSession(
      {
        enabled: true,
        agentId: "agent-local",
        conversationId: "conv-local",
        sigintSignal: sigint.signal,
      },
      async () => ({
        ready: (signal) =>
          signal
            ? Promise.race([
                readyPromise,
                new Promise<boolean>((_resolve, reject) =>
                  signal.addEventListener(
                    "abort",
                    () => reject(new Error("SIGINT")),
                    { once: true },
                  ),
                ),
              ])
            : readyPromise,
        forceStop,
        stopAdmission() {},
        resumeAdmission() {},
        release,
      }),
    );

    const starting = session.start().catch((error: unknown) => error);
    await Bun.sleep(0);
    sigint.abort();
    expect(await starting).toBeInstanceOf(Error);
    session.cancel({ force: true });
    await session.release();
    expect(forceStop).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
  });

  test("routine nonzero shutdown gracefully releases a claimed owner", async () => {
    const release = mock(async () => true);
    const forceStop = mock(() => {});
    const session = startHeadlessLocalSession(
      {
        enabled: true,
        agentId: "agent-local",
        conversationId: "conv-local",
        sigintSignal: new AbortController().signal,
      },
      async () => ({
        ready: async () => true,
        forceStop,
        stopAdmission() {},
        resumeAdmission() {},
        release,
      }),
    );
    await session.start();
    session.cancel();
    await session.release();
    expect(forceStop).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  test("SIGINT interrupts reconnect readiness on subsequent turns", async () => {
    const sigint = new AbortController();
    let readyCalls = 0;
    const session = startHeadlessLocalSession(
      {
        enabled: true,
        agentId: "agent-local",
        conversationId: "conv-local",
        sigintSignal: sigint.signal,
      },
      async () => ({
        ready: async (signal) => {
          readyCalls += 1;
          if (readyCalls === 1) return true;
          return await new Promise<boolean>((_resolve, reject) =>
            signal?.addEventListener(
              "abort",
              () => reject(new Error("SIGINT")),
              { once: true },
            ),
          );
        },
        forceStop() {},
        stopAdmission() {},
        resumeAdmission() {},
        release: async () => true,
      }),
    );
    await session.start();
    const reconnectReady = session.start().catch((error: unknown) => error);
    sigint.abort();
    expect(await reconnectReady).toBeInstanceOf(Error);
  });
});
