export function isHeadlessStartup(
  flags: { prompt?: boolean; run?: boolean },
  stdinIsTTY: boolean | undefined,
  firstPositional: string | null | undefined,
): boolean {
  if (flags.prompt || flags.run) {
    return true;
  }

  // Subcommands have already been routed. A remaining positional is an unknown
  // command unless the caller explicitly selected headless prompt mode.
  if (firstPositional) {
    return false;
  }

  // Preserve stdin-only prompt transport for pipes and spawned subagents.
  return stdinIsTTY !== true;
}
