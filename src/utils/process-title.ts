import { closeSync, openSync, readFileSync, writeSync } from "node:fs";

const TITLE = "letta";

export function hidePromptFromProcessTitle(): void {
  try {
    process.title = TITLE;
  } catch {}

  if (process.platform !== "linux") return;

  try {
    const cmdline = readFileSync("/proc/self/cmdline", "utf8");
    if (cmdline.replace(/\0+$/, "") === TITLE) return;

    const stat = readFileSync("/proc/self/stat", "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const start = Number(fields[48 - 3]);
    const end = Number(fields[49 - 3]);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start <= 0 ||
      end <= start
    ) {
      return;
    }

    const replacement = Buffer.alloc(end - start);
    replacement.write(TITLE, 0, replacement.length - 1);
    const fd = openSync("/proc/self/mem", "r+");
    try {
      let offset = 0;
      while (offset < replacement.length) {
        const written = writeSync(
          fd,
          replacement,
          offset,
          replacement.length - offset,
          start + offset,
        );
        if (written === 0) break;
        offset += written;
      }
    } finally {
      closeSync(fd);
    }
  } catch {}
}
