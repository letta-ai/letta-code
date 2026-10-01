import { writeSync } from "node:fs";

// Cloud alone opts in. Capture at module load, before startup can spawn children.
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
    // Reject malformed managed launches at the content boundary, not at import.
    failure = new Error("Failed to seal startup logs", {
      cause: new Error(
        "LETTA_STARTUP_LOG_OWNER_PID must be a positive integer",
      ),
    });
  } else if (Number(ownerPid) !== process.pid) {
    // Bun spawnSync can inherit the original OS env despite process.env deletion.
    // Only the shell's exec-replacement process may seal the parent's capture.
    marker = undefined;
  }
}

/** Seal the process's merged stdout/stderr startup capture before user content. */
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
    // Do not use stdout.write: Node pipes can buffer it past content on stderr.
    // A short write must finish before any content-producing callback can run.
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(1, bytes, offset, bytes.length - offset);
      if (written === 0)
        throw new Error("Startup marker write made no progress");
      offset += written;
    }
    marker = undefined;
  } catch (cause) {
    // Sticky failure: a caught rejection/reconnect must not enable content later.
    failure = new Error("Failed to seal startup logs", { cause });
    throw failure;
  }
}
