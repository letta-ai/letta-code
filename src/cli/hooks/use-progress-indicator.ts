import { useEffect } from "react";

/**
 * Shows an indeterminate progress indicator in the terminal tab/taskbar
 * while the component is mounted (useful for "waiting for user" states).
 *
 * Uses OSC 9;4 (ConEmu progress bar sequence) supported by:
 * - iTerm2
 * - Windows Terminal
 * - ConEmu
 * - gnome-terminal (VTE)
 *
 * Format: ESC ] 9 ; 4 ; <state> ; <progress> BEL
 * States:
 *   0 = hidden (clear)
 *   1 = normal progress
 *   2 = error state
 *   3 = indeterminate (animated)
 *   4 = warning state
 */

const PROGRESS_INDETERMINATE = "\x1b]9;4;3;0\x07";
const PROGRESS_CLEAR = "\x1b]9;4;0;0\x07";

export function useProgressIndicator(active = true): void {
  useEffect(() => {
    if (!active) return;

    process.stdout.write(PROGRESS_INDETERMINATE);

    return () => {
      process.stdout.write(PROGRESS_CLEAR);
    };
  }, [active]);
}
