import { runAgentsSubcommand } from "./agents";
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
    default:
      return null;
  }
}
