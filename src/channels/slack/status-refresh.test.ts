import { afterEach, expect, mock, test } from "bun:test";
import { makeSource } from "@/channels/gateway-test-support";
import {
  createSlackStatusController,
  type SlackStatusController,
} from "./status-controller";

const controllers: SlackStatusController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.clear();
});

function setup() {
  const writes: string[] = [];
  const setStatus = mock(async (args: { status: string }) => {
    writes.push(args.status);
  });
  const controller = createSlackStatusController({
    ensureApp: async () => undefined,
    ensureWriteClient: async () => ({ assistant: { threads: { setStatus } } }),
    resolveKnownThreadRoot: (id) => id,
  });
  controllers.push(controller);
  const source = makeSource({
    channel: "slack",
    accountId: "account",
    chatId: "C123",
    threadId: "100.1",
    messageId: "100.2",
  });
  return { controller, source, setStatus, writes };
}

test("a failed refresh keeps active ownership and retries the current title on next input", async () => {
  const h = setup();
  await h.controller.activate(h.source, "is working...", "Inspect files");
  h.setStatus.mockRejectedValueOnce(new Error("rate_limited"));
  await h.controller.handleLifecycle({ type: "queued", source: h.source });
  expect(h.controller.activeSources()).toEqual([h.source]);
  await h.controller.handleLifecycle({ type: "queued", source: h.source });
  expect(h.setStatus).toHaveBeenCalledTimes(3);
  expect(h.setStatus).toHaveBeenLastCalledWith(
    expect.objectContaining({
      status: "is working...",
      loading_messages: ["Inspect files"],
    }),
  );
});

test("in-flight and queued refreshes cannot leave activity visible after a reply", async () => {
  const h = setup();
  await h.controller.activate(h.source, "is working...", "Inspect files");
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let visible = "is working...";
  h.setStatus.mockImplementation(async (args) => {
    visible = args.status;
  });
  h.setStatus.mockImplementationOnce(async () => {
    started.resolve();
    await release.promise;
    visible = "is working...";
  });
  const firstRefresh = h.controller.handleLifecycle({
    type: "queued",
    source: h.source,
  });
  await started.promise;
  const secondRefresh = h.controller.handleLifecycle({
    type: "queued",
    source: h.source,
  });
  await Bun.sleep(0);
  visible = ""; // Slack auto-clears when the reply is posted.
  h.controller.markAutoClearedForMessage({ ...h.source });
  release.resolve();
  await Promise.all([firstRefresh, secondRefresh]);
  expect(visible).toBe("");
  expect(h.setStatus).toHaveBeenCalledTimes(3);
  expect(h.controller.activeSources()).toEqual([]);
  await h.controller.handleLifecycle({ type: "queued", source: h.source });
  expect(h.setStatus).toHaveBeenCalledTimes(3);
});

test("remaining work for another thread, account or conversation cannot retain this status", async () => {
  const h = setup();
  for (const other of [
    { ...h.source, threadId: "200.1" },
    { ...h.source, accountId: "other" },
    { ...h.source, conversationId: "other" },
    { ...h.source, agentId: "other" },
  ]) {
    await h.controller.activate(h.source, "is working...", "Inspect files");
    await h.controller.handleLifecycle({
      type: "finished",
      batchId: "batch",
      sources: [h.source],
      remainingSources: [other],
      outcome: "completed",
      stopReason: "end_turn",
    });
    expect(h.writes.at(-1)).toBe("");
    expect(h.controller.activeSources()).toEqual([]);
  }
});

test("closing the controller prevents a queued refresh from writing", async () => {
  const h = setup();
  await h.controller.activate(h.source, "is working...", "Inspect files");
  const refresh = h.controller.handleLifecycle({
    type: "queued",
    source: h.source,
  });
  h.controller.clear();
  await refresh;
  expect(h.setStatus).toHaveBeenCalledTimes(1);
});
