import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { app, dialog } from "electron";
import { applyStartAtLogin } from "./autostart";
import { ListenerSupervisor } from "./listener-supervisor";
import { showEnvironmentNameWindow } from "./name-window";
import { SettingsStore } from "./settings-store";
import { TrayController } from "./tray-controller";
import { UpdateController } from "./update-controller";

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

let isQuitting = false;
let supervisor: ListenerSupervisor | null = null;
let trayController: TrayController | null = null;
let settingsStore: SettingsStore | null = null;
let updateController: UpdateController | null = null;
let updateQuitFallback: NodeJS.Timeout | null = null;

app.on("second-instance", () => showNameWindow());
app.on("window-all-closed", () => undefined);
app.on("before-quit", (event) => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;
  void Promise.resolve(supervisor?.stop()).finally(() => {
    updateController?.stop();
    trayController?.destroy();
    app.exit(0);
  });
});

void app
  .whenReady()
  .then(async () => {
    if (process.platform === "darwin") app.dock?.hide();

    const userDataPath = app.getPath("userData");
    const logPath = join(userDataPath, "logs", "daemon.log");
    settingsStore = new SettingsStore(join(userDataPath, "settings.json"));
    await settingsStore.load();
    let startupAutostartError: unknown;
    try {
      await applyStartAtLogin(settingsStore.current.startAtLogin);
    } catch (error) {
      startupAutostartError = error;
    }

    trayController = new TrayController({
      environmentName: () => settingsStore?.current.environmentName ?? null,
      logPath,
      onChangeEnvironmentName: showNameWindow,
      onQuit: () => app.quit(),
      onInstallUpdate: installUpdateAndRestart,
      onRestart: async () => supervisor?.restart(),
      onStartAtLoginChange: async (enabled) => {
        const previous = settingsStore?.current.startAtLogin ?? false;
        await applyStartAtLogin(enabled);
        try {
          await settingsStore?.setStartAtLogin(enabled);
        } catch (error) {
          await applyStartAtLogin(previous).catch(() => undefined);
          throw error;
        }
        trayController?.refresh();
      },
      startAtLogin: () => settingsStore?.current.startAtLogin ?? false,
      updateVersion: () => updateController?.readyVersion ?? null,
    });
    if (startupAutostartError) {
      trayController.setStatus({
        kind: "error",
        detail:
          startupAutostartError instanceof Error
            ? startupAutostartError.message
            : String(startupAutostartError),
      });
    }

    updateController = new UpdateController({
      onError: (error) => {
        if (isQuitting) void recoverFromUpdateInstallFailure(error);
      },
      onReady: () => trayController?.refresh(),
    });
    updateController.start();

    const environmentName = settingsStore.current.environmentName;
    if (environmentName) await startSupervisor(environmentName, logPath);
    else showNameWindow();
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox("Letta Daemon could not start", message);
    app.exit(1);
  });

function showNameWindow(): void {
  if (!settingsStore) return;
  showEnvironmentNameWindow({
    currentName: settingsStore.current.environmentName,
    onSave: async (name) => {
      const previousName = settingsStore?.current.environmentName;
      await settingsStore?.setEnvironmentName(name);
      trayController?.refresh();
      const logPath = join(app.getPath("userData"), "logs", "daemon.log");
      if (supervisor && previousName !== name) await supervisor.restart(name);
      if (!supervisor) await startSupervisor(name, logPath);
    },
    preloadPath: join(app.getAppPath(), "dist", "preload.cjs"),
  });
}

async function startSupervisor(
  environmentName: string,
  logPath: string,
): Promise<void> {
  try {
    supervisor = new ListenerSupervisor({
      cliPath: resolveCliPath(),
      environmentName,
      executablePath: process.execPath,
      logPath,
      modulePath: resolveRuntimeModulePath(),
      onStatus: (status) => trayController?.setStatus(status),
    });
    await supervisor.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    trayController?.setStatus({ kind: "error", detail: message });
    dialog.showErrorBox("Letta Daemon could not start", message);
  }
}

function resolveCliPath(): string {
  const override = process.env.LETTA_DAEMON_CLI_PATH;
  const candidates = [
    override,
    app.isPackaged ? join(process.resourcesPath, "runtime", "letta.js") : null,
    resolve(app.getAppPath(), "..", "..", "letta.js"),
    resolve(
      app.getAppPath(),
      "node_modules",
      "@letta-ai",
      "letta-code",
      "letta.js",
    ),
  ];
  const cliPath = candidates.find((candidate): candidate is string =>
    Boolean(candidate && existsSync(candidate)),
  );
  if (!cliPath) {
    throw new Error(
      "The bundled Letta Code runtime is missing. Reinstall Letta Daemon.",
    );
  }
  return cliPath;
}

function resolveRuntimeModulePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "app.asar.unpacked", "node_modules")
    : resolve(app.getAppPath(), "..", "..", "node_modules");
}

async function installUpdateAndRestart(): Promise<void> {
  if (!updateController?.readyVersion) return;
  await supervisor?.stop();
  isQuitting = true;
  try {
    updateController.installAndRestart();
    updateQuitFallback = setTimeout(
      () =>
        void recoverFromUpdateInstallFailure(
          new Error("The updater did not restart Letta Daemon."),
        ),
      10_000,
    );
  } catch (error) {
    await recoverFromUpdateInstallFailure(error);
  }
}

async function recoverFromUpdateInstallFailure(error: unknown): Promise<void> {
  if (!isQuitting) return;
  isQuitting = false;
  if (updateQuitFallback) {
    clearTimeout(updateQuitFallback);
    updateQuitFallback = null;
  }
  await supervisor?.start().catch(() => undefined);
  trayController?.setStatus({
    kind: "error",
    detail: error instanceof Error ? error.message : String(error),
  });
}
