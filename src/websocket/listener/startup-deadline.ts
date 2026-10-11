import type { WebSocket } from "ws";
import { debugLog } from "@/utils/debug";
import { setActiveRuntime } from "./runtime";
import {
  isCurrentSocketPair,
  terminateCurrentSocketPair,
} from "./split-stream-lifecycle";
import type { ListenerRuntime, StartListenerOptions } from "./types";

// A reconnect whose startup never reaches the heartbeat leaves Cloud's proxy
// holding an idle socket that it drops after about 125s, and the next
// reconnect can stall on the same wedged step. Bound startup so the listener
// logs the step it reached, recycles the socket pair, and exits after repeated
// stalls so a process supervisor can restart it with fresh state.
export const LISTENER_STARTUP_DEADLINE_MS = 60_000;
export const MAX_CONSECUTIVE_LISTENER_STARTUP_TIMEOUTS = 3;

export type ListenerStartupStep =
  | "socket opened"
  | "initial state sent"
  | "recovery done"
  | "ingress drained"
  | "heartbeat started";

export interface ListenerStartupDeadline {
  reached(step: ListenerStartupStep): void;
  dispose(): void;
}

// Process-wide: re-registration creates a new runtime, but a wedged step (for
// example a hung git child) survives it. Only a started heartbeat resets this.
let consecutiveStartupTimeouts = 0;

export function resetListenerStartupTimeoutsForTests(): void {
  consecutiveStartupTimeouts = 0;
}

/** Lifecycle lines go to the session log even when debug output is off. */
function createListenerLifecycleLog(
  opts: Pick<StartListenerOptions, "onLog">,
): (message: string) => void {
  return (message) => {
    if (opts.onLog) {
      opts.onLog(`[Listen] ${message}`);
      return;
    }
    debugLog("Listen", message);
  };
}

function getStartupDeadlineMs(): number {
  const override = process.env.LETTA_LISTENER_STARTUP_DEADLINE_MS;
  if (override !== undefined) {
    const parsed = Number(override);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return LISTENER_STARTUP_DEADLINE_MS;
}

/**
 * Arm the deadline when the control socket opens. On expiry `terminate`
 * recycles the socket pair through the ordinary close/reconnect path, or
 * `exit` is called instead once startup has stalled
 * MAX_CONSECUTIVE_LISTENER_STARTUP_TIMEOUTS times in a row.
 */
function armListenerStartupDeadline(params: {
  log: (message: string) => void;
  isCurrent: () => boolean;
  terminate: () => void;
  exit: (error: Error) => void;
}): ListenerStartupDeadline {
  const deadlineMs = getStartupDeadlineMs();
  let lastStep: ListenerStartupStep = "socket opened";
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timer = null;
    if (!params.isCurrent()) return;
    consecutiveStartupTimeouts += 1;
    params.log(
      `startup did not finish within ${deadlineMs}ms; last step: ${lastStep} (consecutive timeouts: ${consecutiveStartupTimeouts}/${MAX_CONSECUTIVE_LISTENER_STARTUP_TIMEOUTS})`,
    );
    if (
      consecutiveStartupTimeouts >= MAX_CONSECUTIVE_LISTENER_STARTUP_TIMEOUTS
    ) {
      consecutiveStartupTimeouts = 0;
      params.exit(
        new Error(
          `Listener startup stalled ${MAX_CONSECUTIVE_LISTENER_STARTUP_TIMEOUTS} consecutive times (last step: ${lastStep})`,
        ),
      );
      return;
    }
    params.terminate();
  }, deadlineMs);

  const dispose = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  return {
    reached(step) {
      if (!timer) return;
      lastStep = step;
      params.log(`startup: ${step}`);
      if (step === "heartbeat started") {
        consecutiveStartupTimeouts = 0;
        dispose();
      }
    },
    dispose,
  };
}

/**
 * Startup bookkeeping for one cloud listener connection attempt: the
 * always-on lifecycle log and a deadline armed when the control socket opens.
 */
export function createListenerSocketStartup(
  runtime: ListenerRuntime,
  opts: Pick<StartListenerOptions, "onError" | "onLog">,
  stopRuntime: (runtime: ListenerRuntime, suppressCallbacks: boolean) => void,
): {
  log: (message: string) => void;
  arm: (
    controlSocket: WebSocket,
    getStreamSocket: () => WebSocket | null,
  ) => ListenerStartupDeadline;
} {
  const log = createListenerLifecycleLog(opts);
  return {
    log,
    arm: (controlSocket, getStreamSocket) =>
      armListenerStartupDeadline({
        log,
        isCurrent: () =>
          isCurrentSocketPair(runtime, controlSocket, getStreamSocket()),
        terminate: () =>
          terminateCurrentSocketPair(runtime, controlSocket, getStreamSocket()),
        exit: (error) => {
          // Same teardown as a terminal close; `letta listen` exits on onError.
          setActiveRuntime(null);
          stopRuntime(runtime, true);
          opts.onError(error);
        },
      }),
  };
}
