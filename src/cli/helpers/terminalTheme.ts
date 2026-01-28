export type TerminalTheme = "light" | "dark";

// Cache for the detected theme
let cachedTheme: TerminalTheme | null = null;

/**
 * Query terminal background color using OSC 11 escape sequence.
 * Returns the RGB values or null if query fails/times out.
 *
 * OSC 11 query: \x1b]11;?\x1b\\ or \x1b]11;?\x07
 * Response: \x1b]11;rgb:RRRR/GGGG/BBBB\x1b\\ (or \x07 terminator)
 */
async function queryTerminalBackground(
  timeoutMs = 100,
): Promise<{ r: number; g: number; b: number } | null> {
  // Skip if not a TTY
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return null;
  }

  return new Promise((resolve) => {
    let response = "";
    let resolved = false;

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      process.stdin.setRawMode?.(false);
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
    };

    const timeout = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);

    const onData = (data: Buffer) => {
      response += data.toString();

      // Look for OSC 11 response: ESC]11;rgb:RRRR/GGGG/BBBB followed by ESC\ or BEL
      // Build regex with ESC character to avoid lint warning about control chars in literals
      const ESC = "\x1b";
      const oscPattern = new RegExp(
        `${ESC}\\]11;rgb:([0-9a-fA-F]+)/([0-9a-fA-F]+)/([0-9a-fA-F]+)`,
      );
      const match = response.match(oscPattern);
      if (match) {
        clearTimeout(timeout);
        cleanup();

        // Parse hex values (may be 2 or 4 digits per component)
        const parseComponent = (hex: string): number => {
          // Normalize to 8-bit (0-255)
          if (hex.length === 4) {
            return parseInt(hex.slice(0, 2), 16);
          }
          return parseInt(hex, 16);
        };

        resolve({
          r: parseComponent(match[1] ?? "0"),
          g: parseComponent(match[2] ?? "0"),
          b: parseComponent(match[3] ?? "0"),
        });
      }
    };

    try {
      // Set raw mode to capture response
      process.stdin.setRawMode?.(true);
      process.stdin.resume();
      process.stdin.on("data", onData);

      // Send OSC 11 query (using ST terminator \x1b\\)
      process.stdout.write("\x1b]11;?\x1b\\");
    } catch {
      clearTimeout(timeout);
      cleanup();
      resolve(null);
    }
  });
}

/**
 * Calculate perceived luminance using relative luminance formula.
 * Returns value between 0 (black) and 1 (white).
 * Using sRGB to linear conversion and ITU-R BT.709 coefficients.
 */
function calculateLuminance(r: number, g: number, b: number): number {
  // Normalize to 0-1
  const toLinear = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };

  const rLin = toLinear(r);
  const gLin = toLinear(g);
  const bLin = toLinear(b);

  // ITU-R BT.709 coefficients
  return 0.2126 * rLin + 0.7152 * gLin + 0.0722 * bLin;
}

/**
 * Detect terminal theme using OSC 11 query.
 * Falls back to COLORFGBG env var, then defaults to dark.
 */
export async function detectTerminalThemeAsync(): Promise<TerminalTheme> {
  // Try OSC 11 query first
  const bg = await queryTerminalBackground(100);
  if (bg) {
    const luminance = calculateLuminance(bg.r, bg.g, bg.b);
    // Threshold: 0.5 is mid-gray, but use 0.4 to be more conservative
    // (most "light" themes have luminance > 0.7)
    return luminance > 0.4 ? "light" : "dark";
  }

  // Fall back to COLORFGBG env var
  const colorfgbg = process.env.COLORFGBG;
  if (colorfgbg) {
    const parts = colorfgbg.split(";");
    const bgIdx = parseInt(parts[parts.length - 1] || "0", 10);
    if (bgIdx === 7 || bgIdx === 15) return "light";
  }

  // Default to dark (most common terminal theme)
  return "dark";
}

/**
 * Synchronous theme detection using only COLORFGBG.
 * Use detectTerminalThemeAsync() for more accurate OSC 11 detection.
 */
export function detectTerminalThemeSync(): TerminalTheme {
  const colorfgbg = process.env.COLORFGBG;
  if (colorfgbg) {
    const parts = colorfgbg.split(";");
    const bg = parseInt(parts[parts.length - 1] || "0", 10);
    if (bg === 7 || bg === 15) return "light";
  }
  return "dark";
}

/**
 * Get the cached terminal theme, or detect synchronously if not yet cached.
 * Call initTerminalTheme() early in app startup for async detection.
 */
export function getTerminalTheme(): TerminalTheme {
  if (cachedTheme) return cachedTheme;
  cachedTheme = detectTerminalThemeSync();
  return cachedTheme;
}

/**
 * Initialize terminal theme detection asynchronously.
 * Should be called early in app startup before UI renders.
 */
export async function initTerminalTheme(): Promise<TerminalTheme> {
  cachedTheme = await detectTerminalThemeAsync();
  return cachedTheme;
}

// For backwards compatibility - use sync detection initially
// Colors module will use getTerminalTheme() which returns cached value
export const terminalTheme = detectTerminalThemeSync();
