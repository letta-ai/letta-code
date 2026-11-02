/**
 * The listener's Ink status UI animates a spinner. When stdout is not a
 * terminal (e.g. redirected to a file), every frame would be written out, so
 * fall back to plain log lines.
 */
export function shouldUseNonInteractiveListenerOutput(
  debugMode: boolean,
  lifecycleOutput: boolean,
  stdoutIsTTY: boolean | undefined = process.stdout.isTTY,
): boolean {
  return debugMode || lifecycleOutput || !stdoutIsTTY;
}
