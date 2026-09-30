import { app, Notification } from "electron";
import { autoUpdater } from "electron-updater";

interface UpdateControllerOptions {
  onError(error: Error): void;
  onReady(version: string): void;
}

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

export class UpdateController {
  readonly #options: UpdateControllerOptions;
  #interval: NodeJS.Timeout | null = null;
  #readyVersion: string | null = null;

  constructor(options: UpdateControllerOptions) {
    this.#options = options;
  }

  get readyVersion(): string | null {
    return this.#readyVersion;
  }

  start(): void {
    if (!app.isPackaged || this.#interval) return;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.channel = process.arch === "arm64" ? "latest-arm64" : "latest";
    autoUpdater.on("update-downloaded", (info) => {
      this.#readyVersion = info.version;
      this.#options.onReady(info.version);
      if (Notification.isSupported()) {
        new Notification({
          body: "Restart Letta Daemon to use the latest Letta Code runtime.",
          title: `Letta Daemon ${info.version} is ready`,
        }).show();
      }
    });
    autoUpdater.on("error", (error) => {
      console.error("[updater]", error);
      this.#options.onError(error);
    });
    void this.#check();
    this.#interval = setInterval(
      () => void this.#check(),
      UPDATE_CHECK_INTERVAL_MS,
    );
  }

  stop(): void {
    if (!this.#interval) return;
    clearInterval(this.#interval);
    this.#interval = null;
  }

  installAndRestart(): void {
    if (!this.#readyVersion) return;
    autoUpdater.quitAndInstall(false, true);
  }

  async #check(): Promise<void> {
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      console.error("[updater] update check failed", error);
    }
  }
}
