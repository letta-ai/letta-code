import { useInput } from "ink";
import { useSyncExternalStore } from "react";

/**
 * Global collapsed/expanded state for reasoning spoilers.
 *
 * A module-level store (not React context) so any reasoning block can read
 * the flag without prop drilling through the pinned coordinator/view files,
 * and a single ctrl+t toggles every block at once. StaticTranscript mounts
 * the keyboard listener; unlike the ctrl+o handler in InputRich it is not
 * gated by interactionEnabled — toggling the view is harmless while an
 * overlay or approval owns focus.
 */

let expanded = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function toggleReasoningDisplay() {
  expanded = !expanded;
  for (const listener of listeners) listener();
}

export function useReasoningDisplay(): boolean {
  return useSyncExternalStore(subscribe, () => expanded);
}

/** Keyboard listener for ctrl+t; mounted once by StaticTranscript. */
export function useReasoningDisplayHotkey() {
  useInput((input, key) => {
    if (input === "t" && key.ctrl) toggleReasoningDisplay();
  });
}
