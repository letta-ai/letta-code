import { writeSync } from "node:fs";

let marker = process.env.LETTA_STARTUP_LOG_MARKER;
const ownerPid = process.env.LETTA_STARTUP_LOG_OWNER_PID;
delete process.env.LETTA_STARTUP_LOG_MARKER;
delete process.env.LETTA_STARTUP_LOG_OWNER_PID;
let failure: Error | undefined;

if (ownerPid !== undefined) {
  if (
    !/^[1-9][0-9]*$/.test(ownerPid) ||
    !Number.isSafeInteger(Number(ownerPid))
  ) {
    failure = new Error("Failed to seal startup logs", {
      cause: new Error(
        "LETTA_STARTUP_LOG_OWNER_PID must be a positive integer",
      ),
    });
  } else if (Number(ownerPid) !== process.pid) {
    marker = undefined;
  }
}

export function suppressStartupLogMarker(): void {
  marker = undefined;
}

export function sealStartupLogs(): void {
  if (failure) throw failure;
  if (marker === undefined) return;

  try {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        marker,
      )
    ) {
      throw new Error("LETTA_STARTUP_LOG_MARKER must be a UUID");
    }
    const bytes = Buffer.from(`\n[letta-startup-end:${marker}]\n`);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(1, bytes, offset, bytes.length - offset);
      if (written === 0)
        throw new Error("Startup marker write made no progress");
      offset += written;
    }
    marker = undefined;
  } catch (cause) {
    failure = new Error("Failed to seal startup logs", { cause });
    throw failure;
  }
}
