/**
 * Detects and enables Kitty keyboard protocol support.
 * Based on gemini-cli's implementation.
 * See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
 */
import * as fs from "node:fs";

let detectionComplete = false;
let kittySupported = false;
let kittyEnabled = false;

const DEBUG = process.env.LETTA_DEBUG_KITTY === "1";
const DISABLED = process.env.LETTA_DISABLE_KITTY === "1";

/**
 * Detects Kitty keyboard protocol support.
 * This function should be called once at app startup, before rendering.
 * Set LETTA_DISABLE_KITTY=1 to skip enabling the protocol (useful for debugging).
 */
export async function detectAndEnableKittyProtocol(): Promise<void> {
  if (detectionComplete) {
    return;
  }

  // Allow disabling Kitty protocol for debugging terminal issues
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

      // If the terminal explicitly answered the progressive enhancement query,
      // treat it as supported.
      if (progressiveEnhancementReceived) kittySupported = true;

      // Best-effort: even when the query isn't supported (common in xterm.js),
      // enabling may still work. So we enable whenever we're on a TTY.
      // If unsupported, terminals will just ignore the escape.
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
        // Race condition. We have already timed out.
        return;
      }
      responseBuffer += data.toString();

      if (DEBUG) {
        // eslint-disable-next-line no-console
        console.error("[kitty] rx:", JSON.stringify(data.toString()));
      }

      // Check for progressive enhancement response (CSI ? <flags> u)
      if (responseBuffer.includes("\x1b[?") && responseBuffer.includes("u")) {
        progressiveEnhancementReceived = true;
        // Give more time to get the full set of kitty responses
        clearTimeout(timeoutId);
        timeoutId = setTimeout(finish, 1000);
      }

      // Check for device attributes response (CSI ? <attrs> c)
      if (responseBuffer.includes("\x1b[?") && responseBuffer.includes("c")) {
        // If we also got progressive enhancement, we can be confident.
        if (progressiveEnhancementReceived) kittySupported = true;

        finish();
      }
    };

    process.stdin.on("data", handleData);

    // Query progressive enhancement and device attributes.
    // Many terminals (including VS Code/xterm.js) will only start reporting
    // enhanced keys after this handshake.
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.error("[kitty] querying support");
    }
    fs.writeSync(process.stdout.fd, "\x1b[?u\x1b[c");

    // Timeout after 200ms
    timeoutId = setTimeout(finish, 200);
  });
}

export function isKittyProtocolEnabled(): boolean {
  return kittyEnabled;
}

function enableKittyKeyboardProtocol() {
  try {
    // Enable keyboard progressive enhancement with flag 1 (DISAMBIGUATE_ESCAPE_CODES) only.
    // Previously used flag 7 (1|2|4) but flag 2 (REPORT_EVENT_TYPES) causes release events
    // that leak into input when typing fast in iTerm2/Kitty/etc.
    // Flag 4 (REPORT_ALTERNATE_KEYS) provides data we don't use.
    // Gemini CLI uses flag 1 only - this is the proven approach.
    // See: .notes/csi-u-release-events-fix.md for full analysis.
    fs.writeSync(process.stdout.fd, "\x1b[>1u");
    kittyEnabled = true;
  } catch {
    // Ignore errors
  }
}

function disableKittyKeyboardProtocol() {
  try {
    if (kittyEnabled) {
      fs.writeSync(process.stdout.fd, "\x1b[<u");
      kittyEnabled = false;
    }
  } catch {
    // Ignore errors
  }
}
