import { runAgentsSubcommand } from "./agents";
import { runBlocksSubcommand } from "./blocks";
import { runListenSubcommand } from "./listen.tsx";
import { runMemfsSubcommand } from "./memfs";
import { runMessagesSubcommand } from "./messages";

export async function runSubcommand(argv: string[]): Promise<number | null> {
  const [command, ...rest] = argv;

  if (!command) {
    return null;
  }

  switch (command) {
    case "memfs":
      return runMemfsSubcommand(rest);
    case "agents":
      return runAgentsSubcommand(rest);
    case "messages":
      return runMessagesSubcommand(rest);
    case "blocks":
      return runBlocksSubcommand(rest);
    case "remote":
      return runListenSubcommand(rest);
    default:
      return null;
  }
}
