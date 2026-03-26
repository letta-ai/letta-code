/**
 * Format a number compactly with k/M suffix
 * Examples: 500 -> "500", 5000 -> "5k", 5200 -> "5.2k", 52000 -> "52k"
 * Uses at most 2 significant figures for the decimal part
 */
export function formatCompact(n: number): string {
  if (n < 1000) {
    return String(n);
  }
  if (n < 1_000_000) {
    const k = n / 1000;
    // Show 1 decimal place if < 10k, otherwise round to whole number
    if (k < 10) {
      const rounded = Math.round(k * 10) / 10;
      return `${rounded}k`;
    }
    return `${Math.round(k)}k`;
  }
  // Millions
  const m = n / 1_000_000;
  if (m < 10) {
    const rounded = Math.round(m * 10) / 10;
    return `${rounded}M`;
  }
  return `${Math.round(m)}M`;
}

// 4 bytes per token (Codex heuristic: codex-rs/core/src/truncate.rs APPROX_BYTES_PER_TOKEN = 4)
const BYTES_PER_TOKEN = 4;

/**
 * Estimate token count from a byte count using the 4-bytes-per-token heuristic.
 */
export function bytesToTokens(bytes: number): number {
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

/**
 * Estimate token count from a UTF-8 string using byte length.
 * This is more accurate than charsToTokens for non-ASCII text.
 */
export function estimateTokens(text: string): number {
  return bytesToTokens(Buffer.byteLength(text, "utf8"));
}

/**
 * Rough approximation of tokens from character count.
 * Uses ~4 chars per token as a rough average for English text.
 * Prefer estimateTokens() when you have the actual text string.
 */
export function charsToTokens(chars: number): number {
  return Math.round(chars / 4);
}
