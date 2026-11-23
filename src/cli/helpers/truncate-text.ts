import stringWidth from "string-width";

export function truncateText(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (stringWidth(text) <= maxWidth) return text;
  if (maxWidth <= 3) return ".".repeat(maxWidth);

  const suffix = "...";
  const budget = Math.max(0, maxWidth - stringWidth(suffix));
  let out = "";
  for (const ch of text) {
    const next = out + ch;
    if (stringWidth(next) > budget) break;
    out = next;
  }
  return out + suffix;
}
