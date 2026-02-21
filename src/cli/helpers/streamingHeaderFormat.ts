export type BoldSpan = { start: number; end: number };

function mergeSpans(spans: BoldSpan[]): BoldSpan[] {
  if (spans.length === 0) return [];
  const sorted = [...spans]
    .filter(
      (s) =>
        Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start,
    )
    .sort((a, b) => a.start - b.start);
  const out: BoldSpan[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (!last || s.start > last.end) {
      out.push({ start: s.start, end: s.end });
    } else {
      last.end = Math.max(last.end, s.end);
    }
  }
  return out;
}

/**
 * Minimal streaming-time formatting.
 *
 * We avoid full markdown parsing while streaming, but we *do* special-case the
 * common reasoning pattern where a section heading is emitted as:
 *
 *   **Heading Title**
 *
 * This function:
 * - removes the `**` markers for any line that starts with optional whitespace
 *   then `**`.
 * - marks the heading text (until the closing `**` if present, else until EOL)
 *   as bold.
 *
 * Notes:
 * - Only triggers at line start (or after a newline). Inline `**bold**` is not
 *   handled.
 * - If only one trailing `*` has arrived (half of the closing `**`), we hide it
 *   to avoid flicker.
 */
export function formatStreamingHeaders(input: string): {
  text: string;
  boldSpans: BoldSpan[];
} {
  if (!input) return { text: "", boldSpans: [] };

  const lines = input.split("\n");
  let out = "";
  const spans: BoldSpan[] = [];

  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li] ?? "";
    const base = out.length;

    // Allow indentation; headings produced by models sometimes include it.
    const m = line.match(/^[\t ]*/);
    const leading = m?.[0] ?? "";
    const rest = line.slice(leading.length);

    if (rest.startsWith("**")) {
      const afterOpen = rest.slice(2);
      const closeIdx = afterOpen.indexOf("**");

      if (closeIdx === -1) {
        // No closing yet; hide a single trailing `*` to avoid half-close flicker.
        let headerText = afterOpen;
        if (headerText.endsWith("*") && !headerText.endsWith("**")) {
          headerText = headerText.slice(0, -1);
        }
        out += leading + headerText;
        spans.push({
          start: base + leading.length,
          end: base + leading.length + headerText.length,
        });
      } else {
        const headerText = afterOpen.slice(0, closeIdx);
        const afterClose = afterOpen.slice(closeIdx + 2);
        out += leading + headerText + afterClose;
        spans.push({
          start: base + leading.length,
          end: base + leading.length + headerText.length,
        });
      }
    } else {
      out += line;
    }

    if (li < lines.length - 1) out += "\n";
  }

  return { text: out, boldSpans: mergeSpans(spans) };
}
