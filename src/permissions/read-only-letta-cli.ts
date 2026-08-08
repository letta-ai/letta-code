const READ_ONLY_COMMAND_PATHS: Record<string, readonly (readonly string[])[]> =
  {
    memory: [
      ["status"],
      ["help"],
      ["backups"],
      ["export"],
      ["tokens"],
      ["token-limit", "get"],
    ],
    memfs: [
      ["status"],
      ["help"],
      ["backups"],
      ["export"],
      ["tokens"],
      ["token-limit", "get"],
    ],
    agents: [["list"], ["help"]],
    messages: [["search"], ["list"], ["help"]],
  };

export function isReadOnlyLettaCliInvocation(tokens: string[]): boolean {
  const group = tokens[1];
  if (!group) return false;

  const commandArgs = tokens.slice(2);
  return (
    READ_ONLY_COMMAND_PATHS[group]?.some((safePath) =>
      safePath.every((part, index) => commandArgs[index] === part),
    ) ?? false
  );
}
