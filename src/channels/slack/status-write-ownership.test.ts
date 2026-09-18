import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { ChannelTurnSource } from "@/channels/types";
import {
  createSlackStatusController,
  type SlackStatusController,
} from "./status-controller";

type Status = {
  channel_id: string;
  thread_ts: string;
  status: string;
  loading_messages?: string[];
};
const controllers: SlackStatusController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.clear();
});

function setup() {
  const writes: Status[] = [];
  const visible = new Map<string, Status>();
  function apply(args: Status) {
    if (args.status) expect(args.loading_messages).toHaveLength(1);
    else expect(args.loading_messages).toBeUndefined();
    writes.push(args);
    visible.set(args.thread_ts, args);
  }
  const prepare = mock(async () => undefined);
  const setStatus = mock(async (args: Status) => apply(args));
  const controller = createSlackStatusController({
    ensureApp: async () => undefined,
    ensureWriteClient: async () => {
      await prepare();
      return { assistant: { threads: { setStatus } } };
    },
    resolveKnownThreadRoot: (id) => id,
  });
  controllers.push(controller);
  const source: ChannelTurnSource = {
    channel: "slack",
    accountId: "account",
    chatId: "C123",
    chatType: "channel",
    threadId: "100.1",
    messageId: "100.2",
    agentId: "agent",
    conversationId: "conversation",
  };
  return { controller, source, writes, visible, prepare, setStatus, apply };
}

function holdPreparation(h: ReturnType<typeof setup>) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  h.prepare.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
  });
  return { entered: entered.promise, release: release.resolve };
}

for (const threadId of ["100.1", "200.1"]) {
  test(`refresh prepared for the old title cannot overwrite a newer title on ${threadId}`, async () => {
    const h = setup();
    await h.controller.activate(h.source, "is working...", "Inspect A");
    const gate = holdPreparation(h);
    const refresh = h.controller.handleLifecycle({
      type: "queued",
      source: h.source,
    });
    await gate.entered;
    const next = { ...h.source, threadId };
    await h.controller.activate(next, "is working...", "Inspect B");
    gate.release();
    await refresh;
    expect(
      h.writes.map((write) => [write.thread_ts, write.loading_messages]),
    ).toEqual([
      ["100.1", ["Inspect A"]],
      [threadId, ["Inspect B"]],
    ]);
    await h.controller.handleLifecycle({ type: "queued", source: next });
    expect(h.writes.at(-1)?.loading_messages).toEqual(["Inspect B"]);
  });

  test(`failed old activation cannot deactivate newer activity on ${threadId}`, async () => {
    const h = setup();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const warn = mock(() => undefined);
    const previousWarn = console.warn;
    console.warn = warn;
    h.setStatus.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      throw new Error("old write failed");
    });
    try {
      const first = h.controller.activate(
        h.source,
        "is working...",
        "Inspect A",
      );
      await entered.promise;
      const next = { ...h.source, threadId };
      const second = h.controller.activate(next, "is working...", "Inspect B");
      release.resolve();
      await Promise.all([first, second]);
      expect(h.visible.get(threadId)?.loading_messages).toEqual(["Inspect B"]);
      const count = h.writes.length;
      await h.controller.handleLifecycle({ type: "queued", source: next });
      expect(h.writes).toHaveLength(count + 1);
    } finally {
      console.warn = previousWarn;
    }
  });

  test(`late old deactivation cannot remove newer activity on ${threadId}`, async () => {
    const h = setup();
    await h.controller.activate(h.source, "is working...", "Inspect A");
    const gate = holdPreparation(h);
    const clearing = h.controller.deactivate(h.source);
    await gate.entered;
    const next = { ...h.source, threadId };
    await h.controller.activate(next, "is working...", "Inspect B");
    gate.release();
    await clearing;
    expect(h.visible.get(threadId)?.loading_messages).toEqual(["Inspect B"]);
    expect(h.controller.activeSources()).toEqual([next]);
    const count = h.writes.length;
    await h.controller.handleLifecycle({ type: "queued", source: next });
    expect(h.writes).toHaveLength(count + 1);
    if (threadId !== "100.1") expect(h.visible.get("100.1")?.status).toBe("");
  });

  test(`in-flight old write corrects only its old thread before newer activity on ${threadId}`, async () => {
    const h = setup();
    await h.controller.activate(h.source, "is working...", "Inspect A");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    h.setStatus.mockImplementationOnce(async (args) => {
      entered.resolve();
      await release.promise;
      h.apply(args);
    });
    const refresh = h.controller.handleLifecycle({
      type: "queued",
      source: h.source,
    });
    await entered.promise;
    const queuedRefresh = h.controller.handleLifecycle({
      type: "queued",
      source: h.source,
    });
    const next = { ...h.source, threadId };
    const activity = h.controller.activate(next, "is working...", "Inspect B");
    await Bun.sleep(0);
    expect(h.writes).toHaveLength(1); // The new write cannot overtake the in-flight request.
    release.resolve();
    await Promise.all([refresh, queuedRefresh, activity]);
    expect(h.visible.get(threadId)?.loading_messages).toEqual(["Inspect B"]);
    const expected: Array<[string, string[] | undefined]> = [
      ["100.1", ["Inspect A"]],
      ["100.1", ["Inspect A"]],
    ];
    if (threadId !== "100.1") expected.push(["100.1", undefined]);
    expected.push([threadId, ["Inspect B"]]);
    expect(
      h.writes.map((write) => [write.thread_ts, write.loading_messages]),
    ).toEqual(expected);
  });
}

for (const terminal of ["completion", "reply"] as const) {
  test(`delayed old-thread cleanup still clears after newer-thread ${terminal}`, async () => {
    const h = setup();
    await h.controller.activate(h.source, "is working...", "Inspect A");
    const gate = holdPreparation(h);
    const clearing = h.controller.deactivate(h.source);
    await gate.entered;
    const next = { ...h.source, threadId: "200.1" };
    await h.controller.activate(next, "is working...", "Inspect B");
    if (terminal === "completion") await h.controller.deactivate(next);
    else {
      // Slack clears B when its reply posts; local state follows that reply.
      h.visible.delete("200.1");
      h.controller.markAutoCleared(next);
    }
    gate.release();
    await clearing;
    expect(h.visible.get("100.1")?.status).toBe("");
    expect(h.controller.activeSources()).toEqual([]);
  });
}

for (const reply of ["source", "anchored-message"] as const) {
  for (const relinquish of [false, true]) {
    test(`${reply} followed by relinquish=${relinquish} handles an outstanding old HTTP correctly`, async () => {
      const old = setup();
      const destination = createSlackStatusController({
        ensureApp: async () => undefined,
        ensureWriteClient: async () => ({
          assistant: { threads: { setStatus: old.setStatus } },
        }),
        resolveKnownThreadRoot: (id) => id,
      });
      controllers.push(destination);
      await old.controller.activate(old.source, "is working...", "Old");
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      old.setStatus.mockImplementationOnce(async (args) => {
        entered.resolve();
        await release.promise;
        old.apply(args);
      });
      const pending = old.controller.handleLifecycle({
        type: "queued",
        source: old.source,
      });
      await entered.promise;
      if (reply === "source") old.controller.markAutoCleared(old.source);
      else old.controller.markAutoClearedForMessage(old.source);
      await destination.activate(old.source, "is working...", "Destination");
      if (relinquish) old.controller.relinquish(old.source);
      const count = old.writes.length;
      release.resolve();
      await pending;
      expect(old.writes.slice(count).map((write) => write.status)).toEqual(
        relinquish ? ["is working..."] : ["is working...", ""],
      );
    });
  }
}

test("relinquishing credential-held cleanup for old A cannot revoke current B", async () => {
  let keepalive: (() => void) | undefined;
  const originalTimeout = globalThis.setTimeout;
  const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(
    Object.assign((...args: Parameters<typeof setTimeout>) => {
      if (args[1] === 90_000) keepalive = args[0] as () => void;
      return originalTimeout(...args);
    }, originalTimeout),
  );
  const h = setup();
  try {
    await h.controller.activate(h.source, "is working...", "A");
    const b = { ...h.source, threadId: "200.1" };
    await h.controller.activate(b, "is working...", "B");
    const gate = holdPreparation(h);
    const cleanup = h.controller.deactivate(h.source);
    await gate.entered;
    h.controller.relinquish(h.source);
    gate.release();
    await cleanup;
    expect(h.controller.activeSources()).toEqual([b]);
    const count = h.writes.length;
    await h.controller.activate(b, "is working...", "B");
    await h.controller.handleLifecycle({ type: "queued", source: b });
    expect(h.writes).toHaveLength(count + 1);
    expect(h.writes.at(-1)?.loading_messages).toEqual(["B"]);
    expect(keepalive).toBeDefined();
    keepalive?.();
    await Bun.sleep(0);
    expect(h.writes).toHaveLength(count + 2);
    expect(h.writes.at(-1)?.loading_messages).toEqual(["B"]);
  } finally {
    h.controller.clear();
    timerSpy.mockRestore();
  }
});

test("late relinquish matches outstanding A without deactivating newer B", async () => {
  const h = setup();
  await h.controller.activate(h.source, "is working...", "A");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  h.setStatus.mockImplementationOnce(async (args) => {
    entered.resolve();
    await release.promise;
    h.apply(args);
  });
  const old = h.controller.handleLifecycle({
    type: "queued",
    source: h.source,
  });
  await entered.promise;
  h.controller.markAutoCleared(h.source);
  const b = { ...h.source, threadId: "200.1" };
  const newer = h.controller.activate(b, "is working...", "B");
  h.controller.relinquish(h.source);
  expect(h.controller.activeSources()).toEqual([b]);
  release.resolve();
  await Promise.all([old, newer]);
  expect(h.writes.some((write) => write.status === "")).toBe(false);
  await h.controller.handleLifecycle({ type: "queued", source: b });
  expect(h.writes.at(-1)?.loading_messages).toEqual(["B"]);
});

test("relinquished in-flight write never clears a destination even after source reactivation", async () => {
  const old = setup();
  const destination = createSlackStatusController({
    ensureApp: async () => undefined,
    ensureWriteClient: async () => ({
      assistant: { threads: { setStatus: old.setStatus } },
    }),
    resolveKnownThreadRoot: (id) => id,
  });
  controllers.push(destination);
  await old.controller.activate(old.source, "is working...", "Old");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  old.setStatus.mockImplementationOnce(async (args) => {
    entered.resolve();
    await release.promise;
    old.apply(args);
  });
  const pending = old.controller.handleLifecycle({
    type: "queued",
    source: old.source,
  });
  await entered.promise;
  const queued = old.controller.handleLifecycle({
    type: "queued",
    source: old.source,
  });
  await Bun.sleep(0);
  await destination.activate(old.source, "is working...", "Destination");
  old.controller.relinquish(old.source);
  const reactivated = old.controller.activate(
    { ...old.source, threadId: "200.1" },
    "is working...",
    "New ownership",
  );
  release.resolve();
  await Promise.all([pending, queued, reactivated]);
  // Already-sent HTTP can still replace the destination title. Relinquishment
  // prevents only the destructive compensating empty, not network cancellation.
  expect(old.visible.get("100.1")?.loading_messages).toEqual(["Old"]);
  expect(old.writes.some((write) => write.status === "")).toBe(false);
  expect(old.visible.get("200.1")?.loading_messages).toEqual(["New ownership"]);
});

test("relinquish skips credential-held and queued old writes while allowing new ownership", async () => {
  const h = setup();
  await h.controller.activate(h.source, "is working...", "Old");
  const gate = holdPreparation(h);
  const held = h.controller.handleLifecycle({
    type: "queued",
    source: h.source,
  });
  await gate.entered;
  h.controller.relinquish({ ...h.source, threadId: "wrong" });
  expect(h.controller.activeSources()).toEqual([h.source]);
  h.controller.relinquish(h.source);
  await h.controller.activate(h.source, "is working...", "New");
  gate.release();
  await held;
  expect(h.writes.map((write) => write.loading_messages)).toEqual([
    ["Old"],
    ["New"],
  ]);
});

for (const completion of ["source", "anchored-message"] as const) {
  test(`old-thread ${completion} auto-clear cannot deactivate a different current thread`, async () => {
    const h = setup();
    await h.controller.activate(h.source, "is working...", "Inspect A");
    const next = { ...h.source, threadId: "200.1" };
    await h.controller.activate(next, "is working...", "Inspect B");
    if (completion === "source") h.controller.markAutoCleared(h.source);
    else h.controller.markAutoClearedForMessage(h.source);
    expect(h.controller.activeSources()).toEqual([next]);
    const count = h.writes.length;
    await h.controller.handleLifecycle({ type: "queued", source: next });
    expect(h.writes).toHaveLength(count + 1);
    expect(h.writes.at(-1)?.loading_messages).toEqual(["Inspect B"]);
  });
}

test("unanchored agent-level message clear retains its existing semantics", async () => {
  const h = setup();
  await h.controller.activate(h.source, "is working...", "Inspect A");
  h.controller.markAutoClearedForMessage({
    agentId: h.source.agentId,
    conversationId: h.source.conversationId,
    chatId: h.source.chatId,
  });
  expect(h.controller.activeSources()).toEqual([]);
});

test("same-title source replacement still publishes to the new thread", async () => {
  const h = setup();
  await h.controller.activate(h.source, "is working...", "Inspect files");
  const next = { ...h.source, threadId: "200.1" };
  await h.controller.activate(next, "is working...", "Inspect files");
  expect(h.writes.map((write) => write.thread_ts)).toEqual(["100.1", "200.1"]);
});

for (const terminal of ["reply", "completion", "clear"] as const) {
  test(`${terminal} invalidates refresh waiting on credentials`, async () => {
    const h = setup();
    await h.controller.activate(h.source, "is working...", "Inspect A");
    const gate = holdPreparation(h);
    const refresh = h.controller.handleLifecycle({
      type: "queued",
      source: h.source,
    });
    await gate.entered;
    if (terminal === "reply") h.controller.markAutoCleared(h.source);
    else if (terminal === "completion") await h.controller.deactivate(h.source);
    else h.controller.clear();
    const count = h.writes.length;
    gate.release();
    await refresh;
    expect(h.writes).toHaveLength(count);
    expect(h.controller.activeSources()).toEqual([]);
  });
}
