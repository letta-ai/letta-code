import { runSetup } from "@/auth/setup";
import { settingsManager } from "@/settings-manager";

function printUsage(): void {
  console.log(
    `
Usage:
  letta setup

Re-run the interactive setup menu to choose local mode or sign in with Letta.
`.trim(),
  );
}

export async function runSetupSubcommand(argv: string[]): Promise<number> {
  const [arg, ...rest] = argv;
  if (arg === "help" || arg === "--help" || arg === "-h") {
    printUsage();
    return 0;
  }
  if (arg || rest.length > 0) {
    console.error(
      `Unexpected arguments: ${[arg, ...rest].filter(Boolean).join(" ")}`,
    );
    printUsage();
    return 1;
  }

  await settingsManager.initialize();
  await runSetup();
  return 0;
}
