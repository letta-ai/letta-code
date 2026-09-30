import { join } from "node:path";
import {
  app,
  Menu,
  type NativeImage,
  nativeImage,
  shell,
  Tray,
} from "electron";
import type { DaemonStatus } from "./listener-supervisor";

interface TrayControllerOptions {
  environmentName(): string | null;
  logPath: string;
  onChangeEnvironmentName(): void;
  onQuit(): void;
  onRestart(): Promise<void>;
  onInstallUpdate(): Promise<void>;
  onStartAtLoginChange(enabled: boolean): Promise<void>;
  startAtLogin(): boolean;
  updateVersion(): string | null;
}

export class TrayController {
  readonly #options: TrayControllerOptions;
  readonly #tray: Tray;
  #status: DaemonStatus = { kind: "stopped" };

  constructor(options: TrayControllerOptions) {
    this.#options = options;
    this.#tray = new Tray(createTrayIcon("stopped"));
    this.#tray.setToolTip("Letta Daemon");
    this.#tray.on("click", () => this.#tray.popUpContextMenu());
    this.#render();
  }

  destroy(): void {
    this.#tray.destroy();
  }

  refresh(): void {
    this.#render();
  }

  setStatus(status: DaemonStatus): void {
    this.#status = status;
    this.#tray.setImage(createTrayIcon(status.kind));
    this.#render();
  }

  #render(): void {
    const environmentName = this.#options.environmentName();
    this.#tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Letta Daemon", enabled: false },
        {
          label: formatStatus(this.#status),
          enabled: false,
        },
        { type: "separator" },
        {
          label: environmentName
            ? `Environment: ${environmentName}`
            : "Environment not configured",
          enabled: false,
        },
        {
          label: environmentName
            ? "Rename environment…"
            : "Set environment name…",
          click: () => this.#options.onChangeEnvironmentName(),
        },
        {
          label: "Open Letta",
          click: () => void shell.openExternal("https://chat.letta.com"),
        },
        {
          label: "Show logs",
          click: () => shell.showItemInFolder(this.#options.logPath),
        },
        {
          label: "Restart Letta Code",
          enabled: environmentName !== null,
          click: () =>
            void this.#options
              .onRestart()
              .catch((error: unknown) => this.#reportActionError(error)),
        },
        {
          label: this.#options.updateVersion()
            ? `Install update ${this.#options.updateVersion()} and restart`
            : "Letta Daemon is up to date",
          enabled: this.#options.updateVersion() !== null,
          click: () =>
            void this.#options
              .onInstallUpdate()
              .catch((error: unknown) => this.#reportActionError(error)),
        },
        {
          label: "Start at login",
          type: "checkbox",
          checked: this.#options.startAtLogin(),
          click: (item) =>
            void this.#options
              .onStartAtLoginChange(Boolean(item.checked))
              .catch((error: unknown) => this.#reportActionError(error)),
        },
        { type: "separator" },
        { label: "Quit", click: () => this.#options.onQuit() },
      ]),
    );
  }

  #reportActionError(error: unknown): void {
    this.setStatus({
      kind: "error",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function formatStatus(status: DaemonStatus): string {
  const labels: Record<DaemonStatus["kind"], string> = {
    connected: "Connected — awaiting work",
    error: "Needs attention",
    reconnecting: "Reconnecting",
    starting: "Starting Letta Code",
    stopped: "Stopped",
    working: "Connected — working",
  };
  return status.detail
    ? `Status: ${labels[status.kind]} (${status.detail})`
    : `Status: ${labels[status.kind]}`;
}

function createTrayIcon(status: DaemonStatus["kind"]): NativeImage {
  const variant =
    status === "error" || status === "working" || status === "connected"
      ? status
      : "stopped";
  const image = nativeImage.createFromPath(
    join(app.getAppPath(), "assets", `tray-${variant}.png`),
  );
  if (image.isEmpty()) {
    throw new Error(`The Letta Daemon ${variant} tray icon is missing.`);
  }
  return image;
}
