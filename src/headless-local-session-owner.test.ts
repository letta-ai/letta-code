import { describe, expect, mock, test } from "bun:test";
import type { LocalSessionOwnerHandle } from "@/websocket/local-session-owner";
import {
  startHeadlessLocalSession,
  takeAcceptedHeadlessInputs,
} from "./headless-local-session-owner";

describe("headless local session ownership", () => {
  test("registration is best-effort and never blocks the initial turn", async () => {
    let resolveOwner!: (owner: LocalSessionOwnerHandle) => void;
    const pendingOwner = new Promise<LocalSessionOwnerHandle>((resolve) => {
      resolveOwner = resolve;
    });
    const release = mock(async () => true);
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
    session.start();
    expect(session.owner).toBeNull();
    resolveOwner({
      stopAdmission() {},
      resumeAdmission() {},
      release,
    });
    await Bun.sleep(0);
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
});
