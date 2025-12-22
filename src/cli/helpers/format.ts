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

/**
 * Rough approximation of tokens from character count.
 * Uses ~4 chars per token as a rough average for English text.
 */
export function charsToTokens(chars: number): number {
  return Math.round(chars / 4);
}
