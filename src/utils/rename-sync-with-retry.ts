import { renameSync } from "node:fs";

export function renameSyncWithRetry(
  source: string,
  destination: string,
  platform = process.platform,
  rename = renameSync,
): void {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt++) {
    try {
      rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        platform !== "win32" ||
        attempt >= 9 ||
        !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")
      ) {
        throw error;
      }
      // Antivirus/indexers can briefly hold the freshly written temp file.
      Atomics.wait(sleeper, 0, 0, 10 * (attempt + 1));
    }
  }
}
