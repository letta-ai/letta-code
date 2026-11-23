export function shouldUseNonInteractiveListenerOutput(
  debugMode: boolean,
  lifecycleOutput: boolean,
  stdoutIsTTY: boolean | undefined = process.stdout.isTTY,
): boolean {
  return debugMode || lifecycleOutput || !stdoutIsTTY;
}
