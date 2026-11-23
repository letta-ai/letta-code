export function formatCompact(n: number): string {
  if (n < 1000) {
    return String(n);
  }
  if (n < 1_000_000) {
    const k = n / 1000;
    if (k < 10) {
      const rounded = Math.round(k * 10) / 10;
      return `${rounded}k`;
    }
    return `${Math.round(k)}k`;
  }
  const m = n / 1_000_000;
  if (m < 10) {
    const rounded = Math.round(m * 10) / 10;
    return `${rounded}M`;
  }
  return `${Math.round(m)}M`;
}

const BYTES_PER_TOKEN = 4;

export function bytesToTokens(bytes: number): number {
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

export function estimateTokens(text: string): number {
  return bytesToTokens(Buffer.byteLength(text, "utf8"));
}

export function formatModeLabel(
  modeName: string,
  modeGlyph?: string | null,
): string {
  if (modeGlyph === "") {
    return modeName;
  }
  if (modeGlyph === "⚡︎") {
    return `${modeGlyph}${modeName}`;
  }
  return `${modeGlyph ?? "⏵⏵"} ${modeName}`;
}

export function formatElapsedLabel(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes === 0) {
    return `${seconds}s`;
  }
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours > 0) {
    const parts: string[] = [`${hours}hr`];
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0) parts.push(`${seconds}s`);
    return parts.join(" ");
  }
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}
