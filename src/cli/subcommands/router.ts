import { runAgentsSubcommand } from "./agents";
import { runBackendSubcommand } from "./backend";
import { runChannelsSubcommand } from "./channels";
import { runConnectSubcommand } from "./connect";
import { runCronSubcommand } from "./cron";
import { runDreamSubcommand } from "./dream";
import { runEnvironmentsSubcommand } from "./environments";
import { runListenSubcommand } from "./listen.tsx";
import { runLocalBackendSubcommand } from "./local-backend";
import { runMemorySubcommand } from "./memory";
import { runMessagesSubcommand } from "./messages";
import { runModsSubcommand } from "./mods";
import { asLegacyAppServerCommand, runServerSubcommand } from "./server";
import { runSetupSubcommand } from "./setup";
import { runInstallSubcommand, runSkillsSubcommand } from "./skills";

async function runUpdateSubcommand(): Promise<number> {
  const { manualUpdate } = await import("@/updater/auto-update");
  const result = await manualUpdate();
  console.log(result.message);
  return result.success ? 0 : 1;
}

async function runVersionSubcommand(): Promise<number> {
  const { getVersion } = await import("@/version");
  console.log(`${getVersion()} (Letta Code)`);
  return 0;
}

export function subcommandNeedsEarlyBackendMode(
  command: string | undefined,
): boolean {
  switch (command) {
    case "app-server":
    case "agents":
    case "connect":
    case "dream":
    case "environments":
    case "envs":
    case "install":
    case "memfs":
    case "memory":
    case "messages":
    case "mods":
    case "remote":
    case "server":
    case "skills":
      return true;
    default:
      return false;
  }
}

export async function runSubcommand(argv: string[]): Promise<number | null> {
  const [command, ...rest] = argv;

  if (!command) {
    return null;
  }

  switch (command) {
    case "version":
      return runVersionSubcommand();
    case "update":
    case "upgrade":
      return runUpdateSubcommand();
    case "memory":
    case "memfs": // legacy alias
      return runMemorySubcommand(rest);
    case "agents":
      return runAgentsSubcommand(rest);
    case "app-server":
      console.error(
        "Warning: `letta app-server` is deprecated. Use `letta server --listen` instead.",
      );
      return runServerSubcommand(asLegacyAppServerCommand(rest));
    case "messages":
      return runMessagesSubcommand(rest);
    case "environments":
    case "envs":
      return runEnvironmentsSubcommand(rest);
    case "mods":
      return runModsSubcommand(rest);
    case "server":
      return runServerSubcommand(rest);
    case "remote": // alias
      return runListenSubcommand(rest);
    case "connect":
      return runConnectSubcommand(rest);
    case "backend":
      return runBackendSubcommand(rest);
    case "setup":
      return runSetupSubcommand(rest);
    case "install":
      return runInstallSubcommand(rest);
    case "skills":
      return runSkillsSubcommand(rest);
    case "cron":
      return runCronSubcommand(rest);
    case "dream":
      return runDreamSubcommand(rest);
    case "channels":
      return runChannelsSubcommand(rest);
    case "local-backend":
      return runLocalBackendSubcommand(rest);
    default:
      return null;
  }
}
