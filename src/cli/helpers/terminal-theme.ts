export type TerminalTheme = "light" | "dark";
export type TerminalRgb = { r: number; g: number; b: number };

type TerminalThemeState = {
  cachedTheme: TerminalTheme | null;
  cachedBackground: TerminalRgb | null;
};

const TERMINAL_THEME_STATE_KEY = Symbol.for("letta.terminalThemeState");

function getTerminalThemeState(): TerminalThemeState {
  const globalObject = globalThis as typeof globalThis & {
    [TERMINAL_THEME_STATE_KEY]?: TerminalThemeState;
  };

  globalObject[TERMINAL_THEME_STATE_KEY] ??= {
    cachedTheme: null,
    cachedBackground: null,
  };

  return globalObject[TERMINAL_THEME_STATE_KEY];
}

/**
 * Normalize a hex color component of any length to 8-bit (0-255).
 * OSC 11 responses may return 1, 2, 3, or 4 hex digits per component.
 */
export function parseHexComponent(hex: string): number {
  const value = parseInt(hex, 16);
  const maxForLength = (1 << (hex.length * 4)) - 1;
  return Math.round((value / maxForLength) * 255);
}

/**
 * Query terminal background color using OSC 11 escape sequence.
 * Returns the RGB values or null if query fails/times out.
 *
 * OSC 11 query: \x1b]11;?\x1b\\ or \x1b]11;?\x07
 * Response: \x1b]11;rgb:RRRR/GGGG/BBBB\x1b\\ (or \x07 terminator)
 *
 * IMPORTANT: Must be called before ink takes control of stdin.
 */
async function queryTerminalBackground(
  timeoutMs = 100,
): Promise<TerminalRgb | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return null;
  }

  // Capture initial stdin state to restore it reliably
  const wasRaw = process.stdin.isRaw;
  const wasFlowing = process.stdin.readableFlowing;

  return new Promise((resolve) => {
    let response = "";
    let resolved = false;

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      try {
        process.stdin.removeListener("data", onData);
        process.stdin.setRawMode?.(wasRaw ?? false);
        if (!wasFlowing) {
          process.stdin.pause();
        }
      } catch {
        // Ignore cleanup errors — stdin may already be in a valid state
      }
    };

    const timeout = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);

    const onData = (data: Buffer) => {
      response += data.toString();

      // Build regex with ESC character to avoid lint warning about control chars in literals
      const ESC = "\x1b";
      const oscPattern = new RegExp(
        `${ESC}\\]11;rgb:([0-9a-fA-F]+)/([0-9a-fA-F]+)/([0-9a-fA-F]+)`,
      );
      const match = response.match(oscPattern);
      if (match) {
        clearTimeout(timeout);
        cleanup();

        resolve({
          r: parseHexComponent(match[1] ?? "0"),
          g: parseHexComponent(match[2] ?? "0"),
          b: parseHexComponent(match[3] ?? "0"),
        });
      }
    };

    try {
      process.stdin.setRawMode?.(true);
      process.stdin.resume();
      process.stdin.on("data", onData);

      process.stdout.write("\x1b]11;?\x1b\\");
    } catch {
      clearTimeout(timeout);
      cleanup();
      resolve(null);
    }
  });
}

export function calculateLuminance(r: number, g: number, b: number): number {
  const toLinear = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };

  const rLin = toLinear(r);
  const gLin = toLinear(g);
  const bLin = toLinear(b);

  return 0.2126 * rLin + 0.7152 * gLin + 0.0722 * bLin;
}

export async function detectTerminalThemeAsync(): Promise<TerminalTheme> {
  const bg = await queryTerminalBackground(100);
  if (bg) {
    getTerminalThemeState().cachedBackground = bg;
    const luminance = calculateLuminance(bg.r, bg.g, bg.b);
    // Threshold: 0.5 is mid-gray, but use 0.4 to be more conservative
    // (most "light" themes have luminance > 0.7)
    return luminance > 0.4 ? "light" : "dark";
  }

  const colorfgbg = process.env.COLORFGBG;
  if (colorfgbg) {
    const parts = colorfgbg.split(";");
    const bgIdx = parseInt(parts[parts.length - 1] || "0", 10);
    if (bgIdx === 7 || bgIdx === 15) return "light";
  }

  return "dark";
}

export function detectTerminalThemeSync(): TerminalTheme {
  const colorfgbg = process.env.COLORFGBG;
  if (colorfgbg) {
    const parts = colorfgbg.split(";");
    const bg = parseInt(parts[parts.length - 1] || "0", 10);
    if (bg === 7 || bg === 15) return "light";
  }
  return "dark";
}

export function getTerminalTheme(): TerminalTheme {
  const state = getTerminalThemeState();
  if (state.cachedTheme) return state.cachedTheme;
  state.cachedTheme = detectTerminalThemeSync();
  return state.cachedTheme;
}

export function getTerminalBackgroundColor(): TerminalRgb | null {
  return getTerminalThemeState().cachedBackground;
}

/**
 * Initialize terminal theme detection asynchronously.
 * Should be called early in app startup before UI renders.
 */
export async function initTerminalTheme(): Promise<TerminalTheme> {
  const state = getTerminalThemeState();
  state.cachedTheme = await detectTerminalThemeAsync();
  return state.cachedTheme;
}
