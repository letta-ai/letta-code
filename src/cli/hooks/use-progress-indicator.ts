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

// Show indeterminate progress (animated green bar)
const PROGRESS_INDETERMINATE = "\x1b]9;4;3;0\x07";
// Clear/hide progress
const PROGRESS_CLEAR = "\x1b]9;4;0;0\x07";

/**
 * Hook that shows an indeterminate progress indicator while mounted.
 * Clears the indicator when the component unmounts.
 *
 * @param active - Whether the indicator should be shown (default: true)
 */
export function useProgressIndicator(active = true): void {
  useEffect(() => {
    if (!active) return;

    // Show indeterminate progress on mount
    process.stdout.write(PROGRESS_INDETERMINATE);

    // Clear progress on unmount
    return () => {
      process.stdout.write(PROGRESS_CLEAR);
    };
  }, [active]);
}
