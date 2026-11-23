import * as fs from "node:fs";

let detectionComplete = false;
let kittySupported = false;
let kittyEnabled = false;

const DEBUG = process.env.LETTA_DEBUG_KITTY === "1";
const DISABLED = process.env.LETTA_DISABLE_KITTY === "1";
const DETECTION_TIMEOUT_MS = 150;

export async function detectAndEnableKittyProtocol(): Promise<void> {
  if (detectionComplete) {
    return;
  }

  if (DISABLED) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.error("[kitty] protocol disabled via LETTA_DISABLE_KITTY=1");
    }
    detectionComplete = true;
    return;
  }

  return new Promise((resolve) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      detectionComplete = true;
      resolve();
      return;
    }

    const originalRawMode = process.stdin.isRaw;
    if (!originalRawMode) {
      process.stdin.setRawMode(true);
    }

    let responseBuffer = "";
    let progressiveEnhancementReceived = false;
    let timeoutId: NodeJS.Timeout | undefined;

    const finish = () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      process.stdin.removeListener("data", handleData);
      if (!originalRawMode) {
        process.stdin.setRawMode(false);
      }

      if (progressiveEnhancementReceived) kittySupported = true;

      if (process.stdout.isTTY) {
        if (DEBUG) {
          // eslint-disable-next-line no-console
          console.error("[kitty] enabling protocol");
        }

        enableKittyKeyboardProtocol();
        process.on("exit", disableKittyKeyboardProtocol);
        process.on("SIGTERM", disableKittyKeyboardProtocol);
        process.on("SIGINT", disableKittyKeyboardProtocol);
      } else if (DEBUG && !kittySupported) {
        // eslint-disable-next-line no-console
        console.error(
          "[kitty] protocol query unsupported; enabled anyway (best-effort)",
        );
      }

      detectionComplete = true;
      resolve();
    };

    const handleData = (data: Buffer) => {
      if (timeoutId === undefined) {
        return;
      }
      responseBuffer += data.toString();

      if (DEBUG) {
        // eslint-disable-next-line no-console
        console.error("[kitty] rx:", JSON.stringify(data.toString()));
      }

      if (responseBuffer.includes("\x1b[?") && responseBuffer.includes("u")) {
        progressiveEnhancementReceived = true;
        clearTimeout(timeoutId);
        timeoutId = setTimeout(finish, 1000);
      }

      if (responseBuffer.includes("\x1b[?") && responseBuffer.includes("c")) {
        if (progressiveEnhancementReceived) kittySupported = true;

        finish();
      }
    };

    process.stdin.on("data", handleData);

    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.error("[kitty] querying support");
    }
    fs.writeSync(process.stdout.fd, "\x1b[?u\x1b[c");

    timeoutId = setTimeout(finish, DETECTION_TIMEOUT_MS);
  });
}

export function isKittyProtocolEnabled(): boolean {
  return kittyEnabled;
}

function enableKittyKeyboardProtocol() {
  try {
    fs.writeSync(process.stdout.fd, "\x1b[>1u");
    kittyEnabled = true;
  } catch {}
}

function disableKittyKeyboardProtocol() {
  try {
    if (kittyEnabled) {
      fs.writeSync(process.stdout.fd, "\x1b[<u");
      kittyEnabled = false;
    }
  } catch {}
}
