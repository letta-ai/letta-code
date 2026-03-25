import { runAgentsSubcommand } from "./agents";
import { runBlocksSubcommand } from "./blocks";
import { runConnectSubcommand } from "./connect";
import { runListenSubcommand } from "./listen.tsx";
import { runLogoutSubcommand } from "./logout";
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
    case "server":
    case "remote": // alias
      return runListenSubcommand(rest);
    case "connect":
      return runConnectSubcommand(rest);
    case "logout":
      return runLogoutSubcommand(rest);
    default:
      return null;
  }
}
