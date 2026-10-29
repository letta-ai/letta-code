import { stripShellQuotes } from "./shell-analysis";

// letta CLI read-only subcommands: group -> allowed actions
const SAFE_LETTA_COMMANDS: Record<string, Set<string>> = {
  memory: new Set(["status", "help", "backups", "export", "tokens"]),
  memfs: new Set(["status", "help", "backups", "export", "tokens"]),
  agents: new Set(["list", "help"]),
  steps: new Set(["trace", "help"]),
  messages: new Set(["search", "list", "help"]),
};

// The CLI extracts --backend before dispatching subcommands, wherever it
// appears. Recognize only its literal supported values; other leading options
// must not accidentally turn an invocation into an allowed group/action pair.
export function isReadOnlyLettaCommand(args: string[]): boolean {
  const filtered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    let backend: string | undefined;
    if (arg === "--backend") {
      backend = args[++index];
    } else if (arg.startsWith("--backend=")) {
      backend = stripShellQuotes(arg.slice("--backend=".length));
    } else {
      filtered.push(arg);
      continue;
    }
    if (backend !== "local" && backend !== "api" && backend !== "cloud") {
      return false;
    }
  }

  const [group, action] = filtered;
  if (!group || !action || !Object.hasOwn(SAFE_LETTA_COMMANDS, group)) {
    return false;
  }
  return SAFE_LETTA_COMMANDS[group]?.has(action) ?? false;
}
