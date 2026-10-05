import type WebSocket from "ws";
import {
  MAX_PENDING_STARTUP_FRAME_BYTES,
  MAX_PENDING_STARTUP_FRAMES,
  rawDataByteLength,
  type StartupFrameBuffer,
} from "./startup-frame-buffer";
import type {
  ListenerRuntime,
  StartListenerOptions,
  StartupFrameCapacity,
  StartupFrameHandoff,
  StartupIngressOwner,
} from "./types";

export function createReportedIngressHandler(
  handleMessage: (data: WebSocket.RawData) => Promise<void>,
  report: (errorType: string, error: unknown, context: string) => void,
  onError: (error: Error) => void,
): (data: WebSocket.RawData) => Promise<void> {
  return async (data) => {
    try {
      await handleMessage(data);
    } catch (error) {
      report(
        "listener_message_handler_failed",
        error,
        "listener_message_handler",
      );
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  };
}

export async function waitForStartupOrAbort(
  startup: Promise<void> | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  let onAbort!: () => void;
  const aborted = new Promise<void>((resolve) => {
    onAbort = () => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([startup, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * The replacement lineage this client's reconnect chain belongs to.
 *
 * A live connection is authoritative. Otherwise the lineage comes from the
 * replacement this runtime was itself started from, which is what keeps a
 * multi-hop re-registration chain (`conn-1 -> conn-2 -> conn-3`) on the
 * original lineage even after the physical connection has been suspended and
 * its `ListenerConnectionState` is gone.
 */
export function resolveStartupLineageId(
  runtime: ListenerRuntime,
  opts: Pick<StartListenerOptions, "connectionId" | "replacement">,
): string {
  return (
    runtime.connections.get(opts.connectionId)?.startupOwner.lineageId ??
    opts.replacement?.lineageId ??
    opts.connectionId
  );
}

/**
 * Claim the current generation of a lineage before the transport exists.
 *
 * The cloud client buffers ingress from the moment the control socket opens,
 * which is before the stream channel is prepared and therefore before any
 * connection can be opened. Reserving the owner first gives those frames an
 * exact lineage to be handed to if the attempt dies in that window.
 */
export function reserveStartupIngressOwner(
  runtime: ListenerRuntime,
  opts: Pick<
    StartListenerOptions,
    "connectionId" | "replacement" | "connectionIdCanResume"
  >,
): StartupIngressOwner {
  const lineageId = resolveStartupLineageId(runtime, opts);
  const generation =
    (runtime.startupGenerationByLineage.get(lineageId) ??
      opts.replacement?.generation ??
      0) + 1;
  runtime.startupGenerationByLineage.set(lineageId, generation);
  return {
    lineageId,
    generation,
    handoffEnabled: opts.connectionIdCanResume !== false,
  };
}

function emptyStartupFrameHandoff(): StartupFrameHandoff {
  return { kind: "frames", frames: [], byteLength: 0 };
}

function exceededStartupCapacity(
  frameCount: number,
  byteLength: number,
): StartupFrameCapacity | null {
  if (frameCount > MAX_PENDING_STARTUP_FRAMES) return "frame_count";
  if (byteLength > MAX_PENDING_STARTUP_FRAME_BYTES) return "byte_count";
  return null;
}

/**
 * Park this owner's still-unprocessed requestless frames for its successor.
 *
 * The buffer surrenders those frames, so repeated aborts of the same owner
 * park each frame exactly once. The lineage update is a single discriminated
 * state write: cumulative overflow replaces payload with bounded poison rather
 * than an empty handoff that a successor could accidentally accept.
 */
export function handoffRequestlessStartupFrames(
  runtime: ListenerRuntime,
  owner: StartupIngressOwner,
  buffer: StartupFrameBuffer,
): boolean {
  if (
    !owner.handoffEnabled ||
    runtime.startupGenerationByLineage.get(owner.lineageId) !== owner.generation
  ) {
    return false;
  }
  const frames = buffer.takeRequestlessInputFrames();
  if (frames.length === 0) return false;
  const prior =
    runtime.pendingStartupFramesByLineage.get(owner.lineageId) ??
    emptyStartupFrameHandoff();
  if (prior.kind === "overflow") {
    return true;
  }
  const addedBytes = frames.reduce(
    (total, frame) => total + rawDataByteLength(frame),
    0,
  );
  const byteLength = prior.byteLength + addedBytes;
  const capacity = exceededStartupCapacity(
    prior.frames.length + frames.length,
    byteLength,
  );
  const next: StartupFrameHandoff = capacity
    ? { kind: "overflow", capacity }
    : {
        kind: "frames",
        frames: [...prior.frames, ...frames],
        byteLength,
      };
  runtime.pendingStartupFramesByLineage.set(owner.lineageId, next);
  return true;
}

export type StartupFrameHandoffClaim = {
  readonly handoff: StartupFrameHandoff;
  /** Commit only after the successor buffer has accepted the inherited state. */
  commit(): void;
};

export function claimRequestlessStartupFrameHandoff(
  runtime: ListenerRuntime,
  owner: StartupIngressOwner,
): StartupFrameHandoffClaim {
  if (
    !owner.handoffEnabled ||
    runtime.startupGenerationByLineage.get(owner.lineageId) !== owner.generation
  ) {
    return { handoff: emptyStartupFrameHandoff(), commit: () => {} };
  }
  const handoff =
    runtime.pendingStartupFramesByLineage.get(owner.lineageId) ??
    emptyStartupFrameHandoff();
  return {
    handoff,
    commit: () => {
      // Delete only the exact payload this claim exposed. A newer generation or
      // concurrent handoff must never be erased by a stale activation.
      if (
        handoff.kind === "frames" &&
        runtime.startupGenerationByLineage.get(owner.lineageId) ===
          owner.generation &&
        runtime.pendingStartupFramesByLineage.get(owner.lineageId) === handoff
      ) {
        runtime.pendingStartupFramesByLineage.delete(owner.lineageId);
      }
    },
  };
}

export function activateStartupIngress(
  buffer: StartupFrameBuffer,
  handleMessage: (data: WebSocket.RawData) => Promise<void>,
  isCurrentAndOpen: () => boolean,
  claimHandoff?: () => StartupFrameHandoffClaim,
): () => Promise<boolean> {
  return () => {
    const claim = claimHandoff?.() ?? {
      handoff: emptyStartupFrameHandoff(),
      commit: () => {},
    };
    if (claim.handoff.kind === "overflow") {
      buffer.failOverflow();
      return Promise.resolve(false);
    }
    if (!buffer.prepend(claim.handoff.frames)) return Promise.resolve(false);
    claim.commit();
    return buffer.drainToLive(handleMessage, isCurrentAndOpen);
  };
}
