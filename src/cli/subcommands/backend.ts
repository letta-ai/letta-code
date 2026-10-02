import { type CliBackendMode, parseBackendModeFlag } from "@/cli/args";
import { settingsManager } from "@/settings-manager";

function printUsage(): void {
  console.log(
    `
Usage:
  letta backend              Show the saved default backend
  letta backend cloud        Use Letta Cloud by default
  letta backend local        Use local mode by default
  letta setup                Re-run the interactive setup menu

Use --backend cloud or --backend local for a one-off override without changing
the saved default. The legacy api name remains supported for compatibility.
`.trim(),
  );
}

function formatBackendName(mode: CliBackendMode | undefined): string {
  return mode === "local" ? "local mode" : "Letta Cloud";
}

function formatBackendMode(mode: CliBackendMode): "cloud" | "local" {
  return mode === "api" ? "cloud" : "local";
}

export async function runBackendSubcommand(argv: string[]): Promise<number> {
  const [modeArg, ...rest] = argv;

  if (modeArg === "help" || modeArg === "--help" || modeArg === "-h") {
    printUsage();
    return 0;
  }

  await settingsManager.initialize();

  if (!modeArg) {
    const mode = settingsManager.getSettings().preferredBackendMode ?? "api";
    console.log(
      `Default backend: ${formatBackendName(mode)} (${formatBackendMode(mode)})`,
    );
    console.log(
      "Run `letta backend cloud` or `letta backend local` to change it.",
    );
    return 0;
  }

  if (rest.length > 0) {
    console.error(`Unexpected arguments: ${rest.join(" ")}`);
    printUsage();
    return 1;
  }

  let backendMode: CliBackendMode;
  try {
    backendMode = parseBackendModeFlag(modeArg) ?? "api";
  } catch (error) {
    console.error(
      error instanceof Error ? `Error: ${error.message}` : String(error),
    );
    printUsage();
    return 1;
  }

  settingsManager.updateSettings({ preferredBackendMode: backendMode });
  await settingsManager.flush();

  if (backendMode === "api") {
    console.log("Default backend set to Letta Cloud.");
    console.log("Run `letta` to sign in with Letta if needed.");
  } else {
    console.log("Default backend set to local mode.");
    console.log("Agents you create by default will be stored on this device.");
  }
  console.log(
    "Use `--backend cloud` or `--backend local` for a one-off override.",
  );

  return 0;
}
