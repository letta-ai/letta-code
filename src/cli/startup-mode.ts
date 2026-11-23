import { hidePromptFromProcessTitle } from "@/utils/process-title";

export function isHeadlessStartup(
  flags: { prompt?: boolean; run?: boolean },
  stdinIsTTY: boolean | undefined,
  firstPositional: string | null | undefined,
): boolean {
  if (flags.prompt || flags.run) {
    return true;
  }

  if (firstPositional) {
    return false;
  }

  return stdinIsTTY !== true;
}

export function hideHeadlessPrompt(
  flags: { prompt?: boolean; run?: boolean },
  stdinIsTTY: boolean | undefined,
  positionals: string[],
): void {
  if (
    isHeadlessStartup(flags, stdinIsTTY, positionals[2]) &&
    positionals.slice(2).join(" ")
  ) {
    hidePromptFromProcessTitle();
  }
}
