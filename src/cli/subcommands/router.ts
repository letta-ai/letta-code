import { runAgentsSubcommand } from "./agents";
import { runChannelsSubcommand } from "./channels";
import { runConnectSubcommand } from "./connect";
import { runCronSubcommand } from "./cron";
import { runListenSubcommand } from "./listen.tsx";
import { runLocalBackendSubcommand } from "./localBackend";
import { runMemorySubcommand } from "./memory";
import { runMessagesSubcommand } from "./messages";

async function runUpdateSubcommand(): Promise<number> {
  const { manualUpdate } = await import("@/updater/auto-update");
  const result = await manualUpdate();
  console.log(result.message);
  return result.success ? 0 : 1;
}

export async function runSubcommand(argv: string[]): Promise<number | null> {
  const [command, ...rest] = argv;

  if (!command) {
    return null;
  }

  switch (command) {
    case "update":
    case "upgrade":
      return runUpdateSubcommand();
    case "memory":
    case "memfs": // legacy alias
      return runMemorySubcommand(rest);
    case "agents":
      return runAgentsSubcommand(rest);
    case "messages":
      return runMessagesSubcommand(rest);
    case "server":
    case "remote": // alias
      return runListenSubcommand(rest);
    case "connect":
      return runConnectSubcommand(rest);
    case "cron":
      return runCronSubcommand(rest);
    case "channels":
      return runChannelsSubcommand(rest);
    case "local-backend":
      return runLocalBackendSubcommand(rest);
    default:
      return null;
  }
}
