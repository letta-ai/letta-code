import { afterEach, expect, test } from "bun:test";
import type WebSocket from "ws";
import {
  openListenerConnection,
  suspendListenerConnection,
} from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import {
  createAcceptedInputDispositionLedger,
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
import { StartupFrameBuffer } from "./startup-frame-buffer";
import {
  handoffRequestlessStartupFrames,
  reserveStartupIngressOwner,
  takeRequestlessStartupFrameHandoff,
} from "./startup-ingress";
import type {
  ListenerClientReplacement,
  ListenerRuntime,
  StartListenerOptions,
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

function legacyFrame(marker: string): WebSocket.RawData {
  return Buffer.from(
    JSON.stringify({
      type: "message",
      agentId: "agent-1",
      conversationId: "conversation-1",
      messages: [{ role: "user", content: marker }],
    }),
  );
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
  expect(frameMarkers(firstReplacement.startupFrames)).toEqual(["hop-1"]);

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
  expect(frameMarkers(secondReplacement.startupFrames)).toEqual([
    "hop-1",
    "hop-2",
  ]);

  const third = createRuntime();
  const thirdOpts = optionsFor("conn-3", secondReplacement);
  adoptListenerClientReplacement(third, thirdOpts);
  setActiveRuntime(third);
  const thirdOwner = reserveStartupIngressOwner(third, thirdOpts);
  expect(thirdOwner.lineageId).toBe("conn-1");
  expect(
    frameMarkers(takeRequestlessStartupFrameHandoff(third, thirdOwner)),
    // Nothing was lost or duplicated across two hops.
  ).toEqual(["hop-1", "hop-2"]);
  expect(takeRequestlessStartupFrameHandoff(third, thirdOwner)).toEqual([]);
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
    ledger: createAcceptedInputDispositionLedger(),
    startupFrames: [],
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
