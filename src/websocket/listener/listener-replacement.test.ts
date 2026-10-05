import { afterEach, expect, test } from "bun:test";
import type WebSocket from "ws";
import {
  openListenerConnection,
  suspendListenerConnection,
} from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import {
  getInputDisposition,
  ordinaryInputIdentity,
  rememberInputDisposition,
} from "./input-disposition";
import { createRuntime, startListenerClient, stopRuntime } from "./lifecycle";
import {
  adoptListenerClientReplacement,
  assertAdoptableListenerClientReplacement,
  createListenerClientReplacement,
} from "./listener-replacement";
import { getActiveRuntime, setActiveRuntime } from "./runtime";
import {
  MAX_PENDING_STARTUP_FRAME_BYTES,
  StartupFrameBuffer,
} from "./startup-frame-buffer";
import {
  activateStartupIngress,
  claimRequestlessStartupFrameHandoff,
  handoffRequestlessStartupFrames,
  reserveStartupIngressOwner,
} from "./startup-ingress";
import type {
  ListenerClientReplacement,
  ListenerRuntime,
  StartListenerOptions,
  StartupFrameHandoff,
} from "./types";

const transport = {
  kind: "local" as const,
  bufferedAmount: 0,
  isOpen: () => true,
  send: () => {},
};

function optionsFor(
  connectionId: string,
  replacement?: ListenerClientReplacement,
): StartListenerOptions {
  return {
    connectionId,
    wsUrl: "local://test",
    deviceId: "device",
    connectionName: "test",
    ...(replacement ? { replacement } : {}),
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
}

function legacyFrame(marker: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      type: "message",
      agentId: "agent-1",
      conversationId: "conversation-1",
      messages: [{ role: "user", content: marker }],
    }),
  );
}

function legacyFrameOfByteLength(byteLength: number): WebSocket.RawData {
  const empty = legacyFrame("");
  if (byteLength < empty.byteLength) {
    throw new Error("Requested frame is smaller than its protocol envelope");
  }
  return legacyFrame("x".repeat(byteLength - empty.byteLength));
}

function handoffFrames(handoff: StartupFrameHandoff): WebSocket.RawData[] {
  if (handoff.kind !== "frames") throw new Error("Expected frame handoff");
  return handoff.frames;
}

function frameMarkers(frames: readonly WebSocket.RawData[]): string[] {
  return frames.map(
    (frame) =>
      (
        JSON.parse(frame.toString()) as {
          messages: Array<{ content: string }>;
        }
      ).messages[0]?.content ?? "",
  );
}

/**
 * Run one cloud re-registration hop: open the connection, buffer a requestless
 * frame before it is ready, then take the 1008 path (hand off, suspend, mint a
 * replacement, stop the runtime).
 */
function runReregistrationHop(params: {
  runtime: ListenerRuntime;
  opts: StartListenerOptions;
  marker: string;
}): ListenerClientReplacement {
  const { runtime, opts, marker } = params;
  setActiveRuntime(runtime);
  const owner = reserveStartupIngressOwner(runtime, opts);
  openListenerConnection({
    runtime,
    connectionId: opts.connectionId,
    writer: transport,
    options: opts,
    startupOwner: owner,
  });
  const buffer = new StartupFrameBuffer();
  buffer.accept(legacyFrame(marker), async () => {
    throw new Error("pre-ready frame must not execute on a dying connection");
  });

  handoffRequestlessStartupFrames(runtime, owner, buffer);
  buffer.abort();
  suspendListenerConnection(runtime, opts.connectionId);
  const replacement = createListenerClientReplacement(runtime, opts);
  setActiveRuntime(null);
  stopRuntime(runtime, true);
  return replacement;
}

afterEach(() => setActiveRuntime(null));

test("a multi-hop re-registration chain keeps its original lineage after suspend", () => {
  const first = createRuntime();
  const firstOpts = optionsFor("conn-1");
  const firstReplacement = runReregistrationHop({
    runtime: first,
    opts: firstOpts,
    marker: "hop-1",
  });
  expect(firstReplacement.lineageId).toBe("conn-1");
  expect(Object.keys(firstReplacement).sort()).toEqual([
    "connectionName",
    "deviceId",
    "generation",
    "lineageId",
  ]);

  // Cloud hands back a brand-new physical connection id on every hop. The
  // lineage must stay on conn-1 so the second hop's handoff lands in the same
  // bucket the first hop filled.
  const second = createRuntime();
  const secondOpts = optionsFor("conn-2", firstReplacement);
  adoptListenerClientReplacement(second, secondOpts);
  const secondReplacement = runReregistrationHop({
    runtime: second,
    opts: secondOpts,
    marker: "hop-2",
  });

  expect(secondReplacement.lineageId).toBe("conn-1");

  const third = createRuntime();
  const thirdOpts = optionsFor("conn-3", secondReplacement);
  adoptListenerClientReplacement(third, thirdOpts);
  setActiveRuntime(third);
  const thirdOwner = reserveStartupIngressOwner(third, thirdOpts);
  expect(thirdOwner.lineageId).toBe("conn-1");
  const claim = claimRequestlessStartupFrameHandoff(third, thirdOwner);
  expect(
    frameMarkers(handoffFrames(claim.handoff)),
    // Nothing was lost or duplicated across two hops.
  ).toEqual(["hop-1", "hop-2"]);
  expect(third.pendingStartupFramesByLineage.has("conn-1")).toBe(true);
  claim.commit();
  expect(
    claimRequestlessStartupFrameHandoff(third, thirdOwner).handoff,
  ).toEqual({
    kind: "frames",
    frames: [],
    byteLength: 0,
  });
});

test("cumulative 200 plus 100 requestless frames poison the lineage across token transfer", async () => {
  const first = createRuntime();
  const firstOpts = optionsFor("conn-1");
  setActiveRuntime(first);
  const firstOwner = reserveStartupIngressOwner(first, firstOpts);
  const firstBuffer = new StartupFrameBuffer();
  for (let index = 0; index < 200; index += 1) {
    firstBuffer.accept(legacyFrame(`first-${index}`), async () => {});
  }
  expect(handoffRequestlessStartupFrames(first, firstOwner, firstBuffer)).toBe(
    true,
  );
  const firstReplacement = createListenerClientReplacement(first, firstOpts);
  setActiveRuntime(null);
  stopRuntime(first, true);

  const second = createRuntime();
  const secondOpts = optionsFor("conn-2", firstReplacement);
  adoptListenerClientReplacement(second, secondOpts);
  setActiveRuntime(second);
  const secondOwner = reserveStartupIngressOwner(second, secondOpts);
  const secondBuffer = new StartupFrameBuffer();
  for (let index = 0; index < 100; index += 1) {
    secondBuffer.accept(legacyFrame(`second-${index}`), async () => {});
  }
  expect(
    handoffRequestlessStartupFrames(second, secondOwner, secondBuffer),
  ).toBe(true);
  expect(second.pendingStartupFramesByLineage.get("conn-1")).toEqual({
    kind: "overflow",
    capacity: "frame_count",
  });

  const secondReplacement = createListenerClientReplacement(second, secondOpts);
  expect("startupFrameHandoff" in secondReplacement).toBe(false);
  setActiveRuntime(null);
  stopRuntime(second, true);

  const third = createRuntime();
  const thirdOpts = optionsFor("conn-3", secondReplacement);
  adoptListenerClientReplacement(third, thirdOpts);
  const thirdOwner = reserveStartupIngressOwner(third, thirdOpts);
  let terminations = 0;
  let reports = 0;
  const activationBuffer = StartupFrameBuffer.forSockets(
    { terminate: () => terminations++ },
    () => null,
    () => reports++,
  );
  await expect(
    activateStartupIngress(
      activationBuffer,
      async () => {
        throw new Error("poisoned handoff must not execute");
      },
      () => true,
      () => claimRequestlessStartupFrameHandoff(third, thirdOwner),
    )(),
  ).resolves.toBe(false);
  expect(activationBuffer.phase).toBe("terminated");
  expect(terminations).toBe(1);
  expect(reports).toBe(1);
  expect(third.pendingStartupFramesByLineage.get("conn-1")).toEqual({
    kind: "overflow",
    capacity: "frame_count",
  });
});

test("a successor prepend count overflow poisons the lineage before clearing local frames", async () => {
  const runtime = createRuntime();
  const opts = optionsFor("conn-prepend");
  const owner = reserveStartupIngressOwner(runtime, opts);
  const predecessorBuffer = new StartupFrameBuffer();
  for (let index = 0; index < 200; index += 1) {
    predecessorBuffer.push(legacyFrame(`predecessor-${index}`));
  }
  expect(
    handoffRequestlessStartupFrames(runtime, owner, predecessorBuffer),
  ).toBe(true);

  const successorOwner = reserveStartupIngressOwner(runtime, opts);
  const successorBuffer = new StartupFrameBuffer();
  for (let index = 0; index < 100; index += 1) {
    successorBuffer.push(legacyFrame(`successor-${index}`));
  }
  await expect(
    activateStartupIngress(
      successorBuffer,
      async () => {
        throw new Error("overflowed prepend must not execute");
      },
      () => true,
      () => claimRequestlessStartupFrameHandoff(runtime, successorOwner),
    )(),
  ).resolves.toBe(false);

  expect(successorBuffer.phase).toBe("terminated");
  expect(runtime.pendingStartupFramesByLineage.get("conn-prepend")).toEqual({
    kind: "overflow",
    capacity: "frame_count",
  });

  // A later successor must fail closed rather than seeing A's 200 frames as a
  // healthy handoff after B's 100 local frames were cleared.
  const laterOwner = reserveStartupIngressOwner(runtime, opts);
  const laterBuffer = new StartupFrameBuffer();
  await expect(
    activateStartupIngress(
      laterBuffer,
      async () => {
        throw new Error("poisoned lineage must not execute");
      },
      () => true,
      () => claimRequestlessStartupFrameHandoff(runtime, laterOwner),
    )(),
  ).resolves.toBe(false);
  expect(laterBuffer.phase).toBe("terminated");
});

test("a successor prepend byte overflow records byte poison before local clear", async () => {
  const runtime = createRuntime();
  const opts = optionsFor("conn-prepend-bytes");
  const firstOwner = reserveStartupIngressOwner(runtime, opts);
  const predecessorBuffer = new StartupFrameBuffer();
  predecessorBuffer.push(
    legacyFrameOfByteLength(MAX_PENDING_STARTUP_FRAME_BYTES - 1_000),
  );
  expect(
    handoffRequestlessStartupFrames(runtime, firstOwner, predecessorBuffer),
  ).toBe(true);

  const successorOwner = reserveStartupIngressOwner(runtime, opts);
  const successorBuffer = new StartupFrameBuffer();
  successorBuffer.push(legacyFrameOfByteLength(2_000));
  await expect(
    activateStartupIngress(
      successorBuffer,
      async () => {},
      () => true,
      () => claimRequestlessStartupFrameHandoff(runtime, successorOwner),
    )(),
  ).resolves.toBe(false);
  expect(
    runtime.pendingStartupFramesByLineage.get("conn-prepend-bytes"),
  ).toEqual({
    kind: "overflow",
    capacity: "byte_count",
  });
});

test("cumulative handoff accepts the byte bound and classifies the next frame as byte overflow", () => {
  const runtime = createRuntime();
  const opts = optionsFor("conn-bytes");
  const firstOwner = reserveStartupIngressOwner(runtime, opts);
  const exactBound = legacyFrameOfByteLength(MAX_PENDING_STARTUP_FRAME_BYTES);
  const firstBuffer = new StartupFrameBuffer();
  expect(firstBuffer.push(exactBound)).toBe(true);
  expect(
    handoffRequestlessStartupFrames(runtime, firstOwner, firstBuffer),
  ).toBe(true);
  const atBound = runtime.pendingStartupFramesByLineage.get("conn-bytes");
  expect(atBound?.kind).toBe("frames");
  if (atBound?.kind !== "frames") throw new Error("Expected frame handoff");
  expect(atBound.byteLength).toBe(MAX_PENDING_STARTUP_FRAME_BYTES);
  expect(atBound.frames).toHaveLength(1);

  const secondOwner = reserveStartupIngressOwner(runtime, opts);
  const secondBuffer = new StartupFrameBuffer();
  secondBuffer.push(legacyFrame("one more"));
  expect(
    handoffRequestlessStartupFrames(runtime, secondOwner, secondBuffer),
  ).toBe(true);
  expect(runtime.pendingStartupFramesByLineage.get("conn-bytes")).toEqual({
    kind: "overflow",
    capacity: "byte_count",
  });
});

test("an intentionally stopped 1008 predecessor is an adoptable owner", () => {
  const predecessor = createRuntime();
  setActiveRuntime(predecessor);
  const scope = getOrCreateScopedRuntime(
    predecessor,
    "agent-1",
    "conversation-1",
  );
  rememberInputDisposition(scope, ordinaryInputIdentity("cm-1008"), "started");
  const opts = optionsFor("conn-1");
  const replacement = createListenerClientReplacement(predecessor, opts);
  // 1008 clears the active runtime and stops it before re-registering.
  setActiveRuntime(null);
  stopRuntime(predecessor, true);

  const successor = createRuntime();
  const successorOpts = optionsFor("conn-2", replacement);
  expect(() =>
    assertAdoptableListenerClientReplacement(successorOpts),
  ).not.toThrow();
  adoptListenerClientReplacement(successor, successorOpts);

  const successorScope = getOrCreateScopedRuntime(
    successor,
    "agent-1",
    "conversation-1",
  );
  expect(
    getInputDisposition(successorScope, ordinaryInputIdentity("cm-1008")),
  ).toBe("started");
});

test("a replayed replacement is rejected without disturbing the adopted owner", () => {
  const predecessor = createRuntime();
  setActiveRuntime(predecessor);
  const scope = getOrCreateScopedRuntime(
    predecessor,
    "agent-1",
    "conversation-1",
  );
  rememberInputDisposition(scope, ordinaryInputIdentity("cm-replay"), "queued");
  const opts = optionsFor("conn-1");
  const replacement = createListenerClientReplacement(predecessor, opts);
  const secondToken = createListenerClientReplacement(predecessor, opts);
  setActiveRuntime(null);
  stopRuntime(predecessor, true);

  const successor = createRuntime();
  adoptListenerClientReplacement(successor, optionsFor("conn-2", replacement));

  // Replaying the consumed token, or presenting a second token minted by the
  // same already-succeeded predecessor, must both fail closed.
  const replayed = createRuntime();
  expect(() =>
    adoptListenerClientReplacement(replayed, optionsFor("conn-3", replacement)),
  ).toThrow("Invalid listener replacement lineage: unknown_provenance");
  expect(() =>
    adoptListenerClientReplacement(replayed, optionsFor("conn-3", secondToken)),
  ).toThrow("Invalid listener replacement lineage: superseded_issuer");
  expect(replayed.acceptedInputDispositionLedger.entries.size).toBe(0);

  const successorScope = getOrCreateScopedRuntime(
    successor,
    "agent-1",
    "conversation-1",
  );
  expect(
    getInputDisposition(successorScope, ordinaryInputIdentity("cm-replay")),
  ).toBe("queued");
});

test("a token the issuer has already outlived is rejected as stale", () => {
  const issuer = createRuntime();
  setActiveRuntime(issuer);
  const opts = optionsFor("conn-1");
  reserveStartupIngressOwner(issuer, opts);
  const replacement = createListenerClientReplacement(issuer, opts);

  // The retry-exhausted path leaves the issuer running; a socket that connects
  // afterwards advances the lineage and makes the minted token a stale view.
  reserveStartupIngressOwner(issuer, opts);

  expect(() =>
    adoptListenerClientReplacement(
      createRuntime(),
      optionsFor("conn-2", replacement),
    ),
  ).toThrow("Invalid listener replacement lineage: stale_generation");
});

test("a token from a runtime that is neither active nor stopped is rejected", () => {
  const orphan = createRuntime();
  const opts = optionsFor("conn-1");
  const replacement = createListenerClientReplacement(orphan, opts);
  const unrelated = createRuntime();
  setActiveRuntime(unrelated);

  expect(() =>
    adoptListenerClientReplacement(
      createRuntime(),
      optionsFor("conn-2", replacement),
    ),
  ).toThrow("Invalid listener replacement lineage: unauthoritative_issuer");
});

test("an unadoptable replacement is rejected before the predecessor is stopped", async () => {
  const active = createRuntime();
  setActiveRuntime(active);
  const scope = getOrCreateScopedRuntime(active, "agent-1", "conversation-1");
  rememberInputDisposition(scope, ordinaryInputIdentity("cm-live"), "started");

  // A token shaped exactly like a real one but never issued by this process.
  const forged: ListenerClientReplacement = {
    deviceId: "device",
    connectionName: "test",
    lineageId: "conn-1",
    generation: 1,
  };

  await expect(
    startListenerClient(optionsFor("conn-2", forged)),
  ).rejects.toThrow("Invalid listener replacement lineage: unknown_provenance");

  expect(getActiveRuntime()).toBe(active);
  expect(active.intentionallyClosed).toBe(false);
  expect(getInputDisposition(scope, ordinaryInputIdentity("cm-live"))).toBe(
    "started",
  );
});

test("a stopped predecessor stays stale after its newer successor also stops", () => {
  const stale = createRuntime();
  setActiveRuntime(stale);
  const staleReplacement = createListenerClientReplacement(
    stale,
    optionsFor("conn-stale"),
  );
  setActiveRuntime(null);
  stopRuntime(stale, true);

  const current = createRuntime();
  setActiveRuntime(current);
  const currentReplacement = createListenerClientReplacement(
    current,
    optionsFor("conn-current"),
  );
  setActiveRuntime(null);
  stopRuntime(current, true);

  expect(() =>
    assertAdoptableListenerClientReplacement(
      optionsFor("conn-after-stale", staleReplacement),
    ),
  ).toThrow("Invalid listener replacement lineage: unauthoritative_issuer");

  // Nulling the active pointer preserves the latest runtime's authority: only
  // the stopped current predecessor remains eligible for the next hop.
  expect(() =>
    assertAdoptableListenerClientReplacement(
      optionsFor("conn-after-current", currentReplacement),
    ),
  ).not.toThrow();
});

test("replacement privately snapshots frame bytes across token consumption", () => {
  const predecessor = createRuntime();
  setActiveRuntime(predecessor);
  const opts = optionsFor("conn-frame-snapshot");
  const owner = reserveStartupIngressOwner(predecessor, opts);
  const mutableFrame = legacyFrame("original");
  const buffer = new StartupFrameBuffer();
  buffer.push(mutableFrame);
  handoffRequestlessStartupFrames(predecessor, owner, buffer);
  const replacement = createListenerClientReplacement(predecessor, opts);

  mutableFrame.fill(0);
  const parked = predecessor.pendingStartupFramesByLineage.get(owner.lineageId);
  if (parked?.kind === "frames" && Buffer.isBuffer(parked.frames[0])) {
    parked.frames[0].fill(1);
  }
  setActiveRuntime(null);
  stopRuntime(predecessor, true);

  const successor = createRuntime();
  const successorOpts = optionsFor("conn-frame-snapshot-next", replacement);
  adoptListenerClientReplacement(successor, successorOpts);
  const successorOwner = reserveStartupIngressOwner(successor, successorOpts);
  expect(
    frameMarkers(
      handoffFrames(
        claimRequestlessStartupFrameHandoff(successor, successorOwner).handoff,
      ),
    ),
  ).toEqual(["original"]);
});

test("replacement privately transfers a deep correlation snapshot", () => {
  const predecessor = createRuntime();
  setActiveRuntime(predecessor);
  predecessor.clientMessageIdsByRunIdByConversation = new Map([
    [
      "agent:agent-1::conversation:conversation-1",
      new Map([["run-1", ["cm-1"]]]),
    ],
  ]);
  const replacement = createListenerClientReplacement(
    predecessor,
    optionsFor("conn-correlation"),
  );

  // No mutable payload is exposed, and later predecessor mutation cannot alter
  // the private issuance snapshot.
  expect(Object.isFrozen(replacement)).toBe(true);
  expect("ledger" in replacement).toBe(false);
  expect("startupFrameHandoff" in replacement).toBe(false);
  expect("clientMessageIdsByRunIdByConversation" in replacement).toBe(false);
  predecessor.clientMessageIdsByRunIdByConversation
    .get("agent:agent-1::conversation:conversation-1")
    ?.get("run-1")
    ?.push("cm-predecessor-late");
  setActiveRuntime(null);
  stopRuntime(predecessor, true);

  const successor = createRuntime();
  adoptListenerClientReplacement(
    successor,
    optionsFor("conn-correlation-next", replacement),
  );
  expect(
    successor.clientMessageIdsByRunIdByConversation
      ?.get("agent:agent-1::conversation:conversation-1")
      ?.get("run-1"),
  ).toEqual(["cm-1"]);

  successor.clientMessageIdsByRunIdByConversation
    ?.get("agent:agent-1::conversation:conversation-1")
    ?.get("run-1")
    ?.push("cm-successor");
  expect(
    predecessor.clientMessageIdsByRunIdByConversation
      .get("agent:agent-1::conversation:conversation-1")
      ?.get("run-1"),
  ).toEqual(["cm-1", "cm-predecessor-late"]);
});

test("replacement correlation snapshots enforce conversation and run bounds", () => {
  const predecessor = createRuntime();
  setActiveRuntime(predecessor);
  predecessor.clientMessageIdsByRunIdByConversation = new Map(
    Array.from({ length: 260 }, (_, conversationIndex) => [
      `conversation-${conversationIndex}`,
      new Map(
        Array.from({ length: 35 }, (_unused, runIndex) => [
          `run-${runIndex}`,
          [`cm-${conversationIndex}-${runIndex}`],
        ]),
      ),
    ]),
  );

  const opts = optionsFor("conn-bounded-correlation");
  const replacement = createListenerClientReplacement(predecessor, opts);
  setActiveRuntime(null);
  stopRuntime(predecessor, true);
  const successor = createRuntime();
  adoptListenerClientReplacement(
    successor,
    optionsFor("conn-bounded-correlation-next", replacement),
  );
  expect(successor.clientMessageIdsByRunIdByConversation?.size).toBe(256);
  expect(
    [...(successor.clientMessageIdsByRunIdByConversation?.keys() ?? [])].at(0),
  ).toBe("conversation-4");
  const newestRuns =
    successor.clientMessageIdsByRunIdByConversation?.get("conversation-259");
  expect(newestRuns?.size).toBe(32);
  expect([...(newestRuns?.keys() ?? [])].at(0)).toBe("run-3");
});

test("a delayed stopped-predecessor token cannot replace a newer healthy runtime", async () => {
  const predecessor = createRuntime();
  setActiveRuntime(predecessor);
  const replacement = createListenerClientReplacement(
    predecessor,
    optionsFor("conn-1"),
  );
  setActiveRuntime(null);
  stopRuntime(predecessor, true);

  const healthy = createRuntime();
  setActiveRuntime(healthy);
  const scope = getOrCreateScopedRuntime(
    healthy,
    "agent-healthy",
    "conversation-healthy",
  );
  rememberInputDisposition(
    scope,
    ordinaryInputIdentity("cm-healthy"),
    "started",
  );

  await expect(
    startListenerClient(optionsFor("conn-2", replacement)),
  ).rejects.toThrow(
    "Invalid listener replacement lineage: unauthoritative_issuer",
  );

  expect(getActiveRuntime()).toBe(healthy);
  expect(healthy.intentionallyClosed).toBe(false);
  expect(getInputDisposition(scope, ordinaryInputIdentity("cm-healthy"))).toBe(
    "started",
  );
});
