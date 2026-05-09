export function buildTextParts(
  ...parts: Array<string | undefined | null>
): Array<{ type: "text"; text: string }> {
  const out: Array<{ type: "text"; text: string }> = [];
  for (const part of parts) {
    if (!part) continue;
    out.push({ type: "text", text: part });
  }
  return out;
}
