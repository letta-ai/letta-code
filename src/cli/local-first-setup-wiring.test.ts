import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf-8");
}

describe("local-first setup wiring", () => {
  test("setup menu offers local mode and persists that choice", () => {
    const source = readSource("../auth/setup-ui.tsx");

    expect(source).toContain('const LOCAL_MODE_LABEL = "Proceed locally"');
    expect(source).toContain('const AUTH_LOGIN_LABEL = "Sign in with Letta"');
    expect(source).toContain(
      'initialMode === "device-code" || localModeDisabled ? 0 : 1',
    );
    expect(source).toContain('configureBackendMode("local")');
    expect(source).toContain(
      'settingsManager.updateSettings({ preferredBackendMode: "local" })',
    );
    expect(source).toContain("letta setup");
    expect(source).toContain("letta backend cloud");
    expect(source).toContain("Agents you create are local to");
    expect(source).toContain("chat.letta.com");
    expect(source).toContain("Welcome to Letta Code");
    expect(source).not.toContain("Welcome to Letta Code.");
    expect(source).not.toContain("Welcome to Letta Code!");
    expect(source).not.toContain("How do you want to start?");
    expect(source).not.toContain("Choose where your agents should live");
  });

  test("successful cloud login records the api backend preference", () => {
    const source = readSource("../auth/LettaLoginView.tsx");
    const start = source.indexOf("settingsManager.updateSettings({");
    const end = source.indexOf("await settingsManager.flush();", start);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).toContain('preferredBackendMode: "api"');
  });

  test("reauthentication paths do not trust stale stored credentials", () => {
    const loginSource = readSource("../auth/LettaLoginView.tsx");
    const setupSource = readSource("../auth/setup-ui.tsx");
    const setupRunnerSource = readSource("../auth/setup.ts");
    const overlaySource = readSource("./components/LettaLoginOverlay.tsx");
    const indexSource = readSource("../index.ts");

    expect(loginSource).not.toContain("onAlreadyLoggedIn");
    expect(loginSource).not.toContain("currentSettings.env?.LETTA_API_KEY");
    expect(loginSource).toContain("Requesting authorization code...");
    expect(loginSource).toContain(
      "LETTA_API_KEY is set in your environment, so OAuth login cannot replace the credential Letta Code is using.",
    );

    expect(setupSource).toContain(
      'initialMode === "device-code" || localModeDisabled ? 0 : 1',
    );
    expect(setupSource).toContain('onCancel={() => setMode("menu")}');
    expect(setupRunnerSource).toContain("initialMode?: SetupInitialMode");
    expect(setupRunnerSource).toContain("Promise<SetupResult>");
    expect(setupRunnerSource).toContain('settle({ kind: "cancelled" })');
    expect(setupRunnerSource).toContain("instance.unmount()");

    expect(overlaySource).toContain(
      "validateCredentialsWithResult(baseURL, apiKey)",
    );
    expect(overlaySource).toContain("onAlreadyLoggedInRef.current()");
    expect(overlaySource).toContain("Could not verify current credentials");
    expect(indexSource).toContain(
      "LETTA_API_KEY is set in your environment, so setup cannot replace the credential Letta Code is using.",
    );
    expect(indexSource).toContain(
      'initialMode: baseURL === LETTA_CLOUD_API_URL ? "device-code" : "menu"',
    );
    expect(indexSource).toContain('setupResult.kind === "cancelled"');
    expect(indexSource).toContain("const shouldValidateCredentials =");
    expect(indexSource).toContain(
      "baseURL === LETTA_CLOUD_API_URL || Boolean(apiKey)",
    );
  });

  test("explicit cloud agent setup disables local mode to avoid restart loops", () => {
    const setupSource = readSource("../auth/setup-ui.tsx");
    const setupRunnerSource = readSource("../auth/setup.ts");
    const indexSource = readSource("../index.ts");

    expect(setupSource).toContain("localModeDisabledReason?: string");
    expect(setupSource).toContain(
      "const localModeDisabled = Boolean(localModeDisabledReason)",
    );
    expect(setupSource).toContain("localModeDisabled ? [0, 2] : [0, 1, 2]");
    expect(setupSource).toContain("Proceed locally");
    expect(setupSource).toContain("(unavailable)");
    expect(setupSource).toContain("selectedOption === 1 && !localModeDisabled");
    expect(setupRunnerSource).toContain("localModeDisabledReason?: string");
    expect(setupRunnerSource).toContain(
      "localModeDisabledReason: options.localModeDisabledReason",
    );

    expect(indexSource).toContain("const setupLocalModeDisabledReason =");
    expect(indexSource).toContain('inferredBackendModeFromAgentId === "api"');
    expect(indexSource).toContain("is a cloud-hosted agent");
    expect(indexSource).toContain("rerun without --agent to start locally");
    expect(indexSource).toContain(
      "localModeDisabledReason: setupLocalModeDisabledReason",
    );
  });

  test("startup completes terminal preflight before rendering setup UI", () => {
    const source = readSource("../index.ts");
    const setupCalls = [...source.matchAll(/runSetup\(/g)];

    expect(source).toContain("const ensureTerminalPreflightComplete");
    expect(setupCalls.length).toBeGreaterThanOrEqual(3);
    for (const match of setupCalls) {
      const prefix = source.slice(Math.max(0, match.index - 220), match.index);
      expect(prefix).toContain("await ensureTerminalPreflightComplete();");
    }
  });

  test("startup auto-enters local mode for credentialless new users while honoring saved local preference", () => {
    const source = readSource("../index.ts");
    const start = source.indexOf('settings.preferredBackendMode === "local"');
    const end = source.indexOf(
      "await tryConfigureStartupLocalBackend()",
      start,
    );

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const segment = source.slice(start - 120, end + 60);
    expect(segment).toContain("!explicitBackendMode");
    expect(segment).toContain("baseURL === LETTA_CLOUD_API_URL");
    expect(segment).toContain('settings.preferredBackendMode === "local"');
    expect(segment).not.toContain("!apiKey");
    expect(segment).not.toContain("!settings.refreshToken");

    const setupStart = source.indexOf(
      "Local-first new-user flow: if the user has no Letta Cloud credentials",
    );
    const setupEnd = source.indexOf(
      "const startupTargetLookupOrder",
      setupStart,
    );
    expect(setupStart).toBeGreaterThan(-1);
    expect(setupEnd).toBeGreaterThan(setupStart);
    const setupSegment = source.slice(
      setupStart,
      setupEnd + "await settingsManager.flush();".length,
    );
    expect(setupSegment).toContain("!explicitBackendMode");
    expect(setupSegment).toContain("!isHeadless");
    expect(setupSegment).toContain("!settings.refreshToken");
    expect(setupSegment).toContain("!apiKey");
    expect(setupSegment).toContain("await tryConfigureStartupLocalBackend()");
    expect(setupSegment).toContain(
      'settingsManager.updateSettings({ preferredBackendMode: "local" })',
    );
    expect(setupSegment).toContain("await settingsManager.flush();");
  });

  test("local transcript migration errors do not block setup login fallback", () => {
    const source = readSource("../index.ts");

    expect(source).toContain("isLocalBackendTranscriptStartupError");
    expect(source).toContain("LocalTranscriptMigrationRequiredError");
    expect(source).toContain("Unsupported local transcript format");
    expect(source).toContain("const tryConfigureStartupLocalBackend");
    expect(source).toContain("Continuing to setup/login");
    expect(source).toContain('configureBackendMode("api")');
    expect(source).toContain('preferredBackendMode: "api"');
  });

  test("backend and setup subcommands expose default backend controls", () => {
    const router = readSource("./subcommands/router.ts");
    const backendCommand = readSource("./subcommands/backend.ts");
    const setupCommand = readSource("./subcommands/setup.ts");

    expect(router).toContain('case "backend"');
    expect(router).toContain('case "setup"');
    expect(backendCommand).toContain("letta backend cloud");
    expect(backendCommand).toContain("letta backend local");
    expect(backendCommand).toContain("resolveStartupBackendDisplay");
    expect(backendCommand).toContain("Proceed locally selected");
    expect(backendCommand).toContain(
      "settingsManager.updateSettings({ preferredBackendMode: backendMode })",
    );
    expect(setupCommand).toContain("await runSetup()");
  });
});
