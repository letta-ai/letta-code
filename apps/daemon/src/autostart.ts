import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import { renderLinuxAutostart } from "./linux-autostart";

const AUTOSTART_FILENAME = "com.letta.daemon.desktop";

export async function applyStartAtLogin(enabled: boolean): Promise<void> {
  if (!app.isPackaged) return;
  if (process.platform !== "linux") {
    app.setLoginItemSettings({ openAtLogin: enabled });
    return;
  }

  const autostartDirectory = join(app.getPath("appData"), "autostart");
  const autostartPath = join(autostartDirectory, AUTOSTART_FILENAME);
  if (!enabled) {
    await rm(autostartPath, { force: true });
    return;
  }

  await mkdir(autostartDirectory, { recursive: true });
  const executablePath = process.env.APPIMAGE ?? app.getPath("exe");
  await writeFile(autostartPath, renderLinuxAutostart(executablePath), {
    mode: 0o644,
  });
}
