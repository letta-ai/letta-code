import {
  BrowserWindow,
  ipcMain,
  type WebContents,
  type WebFrameMain,
} from "electron";
import { validateEnvironmentName } from "./settings-store";

interface EnvironmentNameWindowOptions {
  currentName: string | null;
  onSave(name: string): Promise<void>;
  preloadPath: string;
}

let environmentNameWindow: BrowserWindow | null = null;
let saveEnvironmentName: ((name: string) => Promise<void>) | null = null;

export function showEnvironmentNameWindow(
  options: EnvironmentNameWindowOptions,
): void {
  saveEnvironmentName = options.onSave;
  if (environmentNameWindow && !environmentNameWindow.isDestroyed()) {
    environmentNameWindow.show();
    environmentNameWindow.focus();
    return;
  }

  const window = new BrowserWindow({
    alwaysOnTop: true,
    backgroundColor: "#151719",
    center: true,
    height: 320,
    maximizable: false,
    minimizable: false,
    resizable: false,
    show: false,
    title: "Letta Daemon",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: options.preloadPath,
      sandbox: true,
    },
    width: 440,
  });
  environmentNameWindow = window;
  window.setMenuBarVisibility(false);
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.once("ready-to-show", () => window.show());
  window.once("closed", () => {
    if (environmentNameWindow === window) environmentNameWindow = null;
  });

  void window.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(renderNamePage(options.currentName))}`,
  );
}

ipcMain.handle(
  "daemon:save-environment-name",
  async (event, value: unknown): Promise<{ message?: string; ok: boolean }> => {
    try {
      if (!isCurrentEnvironmentNameWindow(event.sender, event.senderFrame)) {
        throw new Error("The settings request did not come from this window.");
      }
      const name = validateEnvironmentName(value);
      if (!saveEnvironmentName) throw new Error("Settings are not ready.");
      await saveEnvironmentName(name);
      environmentNameWindow?.close();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  },
);

ipcMain.on("daemon:cancel-environment-name", (event) => {
  if (isCurrentEnvironmentNameWindow(event.sender, event.senderFrame)) {
    environmentNameWindow?.close();
  }
});

function isCurrentEnvironmentNameWindow(
  sender: WebContents,
  senderFrame: WebFrameMain | null,
): boolean {
  const window = environmentNameWindow;
  return Boolean(
    window &&
      !window.isDestroyed() &&
      sender === window.webContents &&
      senderFrame === window.webContents.mainFrame,
  );
}

function renderNamePage(currentName: string | null): string {
  const value = escapeHtml(currentName ?? "");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Letta Daemon</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: radial-gradient(circle at 15% 0%, #23363a 0, #151719 42%); color: #f7f8f8; }
      main { display: flex; min-height: 100vh; flex-direction: column; justify-content: center; padding: 28px 32px; }
      .eyebrow { margin: 0 0 8px; color: #6fe7ee; font-size: 11px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
      h1 { margin: 0; font-size: 22px; font-weight: 650; letter-spacing: -.02em; }
      p { margin: 8px 0 18px; color: #aeb5b7; font-size: 13px; line-height: 1.45; }
      label { display: block; margin-bottom: 7px; color: #d8dcdd; font-size: 12px; font-weight: 600; }
      input { width: 100%; height: 40px; border: 1px solid #3c4447; border-radius: 9px; outline: none; background: #0f1112; color: #fff; padding: 0 12px; font: inherit; }
      input:focus { border-color: #61dce5; box-shadow: 0 0 0 3px rgb(97 220 229 / 14%); }
      .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
      button { height: 34px; border: 0; border-radius: 8px; padding: 0 14px; font: 600 12px inherit; cursor: pointer; }
      .cancel { background: #282d2f; color: #d8dcdd; }
      .save { background: linear-gradient(135deg, #61dce5, #a96df2); color: #101213; }
      .error { min-height: 16px; margin-top: 8px; color: #ff8d9b; font-size: 11px; }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">Letta Daemon</p>
      <h1>Name this environment</h1>
      <p>Your agents will use this name when choosing where to run.</p>
      <form id="form">
        <label for="name">Environment name</label>
        <input id="name" maxlength="64" autocomplete="off" autofocus value="${value}" placeholder="Home workstation" />
        <div class="error" id="error" role="alert"></div>
        <div class="actions">
          <button class="cancel" id="cancel" type="button">Cancel</button>
          <button class="save" type="submit">Save &amp; connect</button>
        </div>
      </form>
    </main>
    <script>
      const form = document.getElementById('form');
      const input = document.getElementById('name');
      const error = document.getElementById('error');
      document.getElementById('cancel').addEventListener('click', () => window.lettaDaemon.cancelEnvironmentName());
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        error.textContent = '';
        const result = await window.lettaDaemon.saveEnvironmentName(input.value);
        if (!result.ok) error.textContent = result.message || 'Unable to save the environment name.';
      });
    </script>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
