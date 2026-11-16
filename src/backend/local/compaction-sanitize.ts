/**
 * Replace ASCII C0 control characters (preserving tab, LF, CR) and DEL with
 * spaces so binary tool output in a compaction summary transcript does not
 * cause OpenAI-compatible providers to reject the request with HTTP 400.
 */
export function stripSummaryControlChars(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const isC0 = code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
    out += isC0 || code === 0x7f ? " " : text[i];
  }
  return out;
}
