import { LETTA_CLOUD_API_URL } from "@/auth/oauth";
import { type CliBackendMode, parseBackendModeFlag } from "@/cli/args";
import { settingsManager } from "@/settings-manager";

function printUsage(): void {
  console.log(
    `
Usage:
  letta backend              Show the saved default backend
  letta backend api          Use Letta Cloud by default
  letta backend local        Use local mode by default
  letta setup                Re-run the interactive setup menu

Use --backend api or --backend local for a one-off override without changing
the saved default.
`.trim(),
  );
}

function formatBackendName(mode: CliBackendMode | undefined): string {
  return mode === "local" ? "local mode" : "Letta Cloud";
}

async function resolveSavedDefaultBackend(): Promise<CliBackendMode> {
  const settings = await settingsManager.getSettingsWithSecureTokens();
  const apiKey = process.env.LETTA_API_KEY || settings.env?.LETTA_API_KEY;
  const baseURL =
    process.env.LETTA_BASE_URL ||
    settings.env?.LETTA_BASE_URL ||
    LETTA_CLOUD_API_URL;
  const hasCloudCredentials = Boolean(apiKey || settings.refreshToken);

  if (
    baseURL === LETTA_CLOUD_API_URL &&
    (settings.preferredBackendMode === "local" ||
      (!hasCloudCredentials && settings.preferredBackendMode !== "api"))
  ) {
    return "local";
  }

  return "api";
}

export async function runBackendSubcommand(argv: string[]): Promise<number> {
  const [modeArg, ...rest] = argv;

  if (modeArg === "help" || modeArg === "--help" || modeArg === "-h") {
    printUsage();
    return 0;
  }

  await settingsManager.initialize();

  if (!modeArg) {
    const mode = await resolveSavedDefaultBackend();
    console.log(`Default backend: ${formatBackendName(mode)} (${mode})`);
    console.log(
      "Run `letta backend api` or `letta backend local` to change it.",
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
    console.log(
      "Run `letta` to sign in with Login to Constellation if needed.",
    );
  } else {
    console.log("Default backend set to local mode.");
    console.log("Agents you create by default will be stored on this device.");
  }
  console.log(
    "Use `--backend api` or `--backend local` for a one-off override.",
  );

  return 0;
}
